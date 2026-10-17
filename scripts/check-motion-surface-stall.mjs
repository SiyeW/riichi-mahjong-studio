import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {_electron as electron} from 'playwright'
import {stableForegroundSample} from '../src/testing/motionProbeSurface.ts'
// This intentionally takes foreground control. Run only with explicit human
// authority in this task; never include it in the unattended/default CI gate.
assert.equal(process.env.RMS_UI_FOREGROUND_AUTHORIZED,'1','Current-task foreground authorization is required')
const root=path.resolve(import.meta.dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'rms-native-worker-surface-'))
await fs.mkdir(path.join(root,'.mjai-runtime'),{recursive:true})
const evidence=await fs.mkdtemp(path.join(root,'.mjai-runtime/motion-surface-'))
const rasterization=process.env.RMS_MOTION_SURFACE_RASTERIZATION||'default'
assert.ok(['default','cpu','gpu'].includes(rasterization))
let server,application,page,busy
try {
 server=await createServer({root,mode:'desktop-test',cacheDir:path.join(temp,'vite'),optimizeDeps:{entries:['src/main.ts']},server:{host:'127.0.0.1',port:5297,strictPort:true}});await server.listen()
 const flags=rasterization==='gpu'?['--enable-gpu-rasterization']:rasterization==='cpu'?['--disable-gpu-rasterization']:[]
 application=await electron.launch({args:[...flags,path.join(root,'scripts/electron-motion-surface-test-main.cjs')],env:{...process.env,RMS_NATIVE_PROBE_DATA:path.join(temp,'browser'),RMS_NATIVE_PROBE_URL:server.resolvedUrls.local[0]+'scripts/visual-tests/discard-motion/index.html'}})
 page=await application.firstWindow();await page.waitForFunction(()=>document.body.dataset.ready==='true')
 await page.evaluate(async()=>{
  ;(await import('/scripts/visual-tests/discard-motion/preview.ts')).dispose()
  document.body.innerHTML='<div class="tileDiv" style="position:absolute;left:400px;top:400px"><img class="tileImg" src="/src/assets/tiles/Regular_shortnames/5m.svg"></div>'
  document.body.style.cssText='margin:0;background:#02191e;display:block;overflow:hidden;--zoom:2'
  await document.querySelector('img').decode()
  const {createDiscardCoverageRenderer}=await import('/src/discardMotion/coverage.ts')
  window.surfaceProbe=createDiscardCoverageRenderer();window.surfaceProbe.start()
 })
 await page.waitForFunction(()=>window.surfaceProbe.ready)
 const readSurface=async()=>({...await application.evaluate(({app,BrowserWindow,screen,powerMonitor})=>{
  const w=BrowserWindow.getAllWindows()[0],bounds=w.getBounds()
  return {visible:w.isVisible(),focused:w.isFocused(),opacity:w.getOpacity(),maximized:w.isMaximized(),mode:'native',bounds,contentBounds:w.getContentBounds(),display:screen.getDisplayMatching(bounds),...global.nativeProbe.events,power:{idleState:powerMonitor.getSystemIdleState(5)},rendererFeatures:app.getGPUFeatureStatus()}
 }),...await page.evaluate(()=>({documentVisibility:document.visibilityState,pixelRatio:devicePixelRatio}))})
 const before=await readSurface();assert.notEqual(before.power.idleState,'locked');assert.equal(before.focused,true)
 let announce
 const started=new Promise(resolve=>{announce=resolve})
 await page.exposeFunction('__nativeStallBegan',value=>announce(value))
 busy=page.evaluate(async()=>{
  const {getUiMotionDurationMs,getUiMotionEasing}=await import('/src/uiMotion.ts')
  const duration=getUiMotionDurationMs(),easing=getUiMotionEasing()
  if(duration!==110)throw Error('The surface proof must use the actual shared110ms duration')
  const source=document.querySelector('.tileDiv'),movement=source.animate([{transform:'translateX(0px)'},{transform:'translateX(800px)'}],{duration,easing,fill:'forwards'})
  window.surfaceProbeMovement=movement
  window.surfaceProbeFlight=window.surfaceProbe.prepare({source,effects:[],movement,duration,easing,dx:800,dy:0})
  const until=performance.now()+4000
  while(!document.querySelector('.discard-flight-coverage')){if(performance.now()>until)throw Error('Surface admission failed');await new Promise(r=>setTimeout(r,1))}
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
  const start=performance.timeOrigin+performance.now()
  const motionStart=performance.timeOrigin+Number(document.querySelector('.discard-flight-coverage').dataset.startTime)
  void window.__nativeStallBegan({start,motionStart})
  while(performance.timeOrigin+performance.now()-start<140){}
  return {start,motionStart,end:performance.timeOrigin+performance.now()}
 })
 let startTimer
 try {await Promise.race([started,busy.then(()=>{throw Error('No stall-start announcement was received')}),new Promise((_,reject)=>{startTimer=setTimeout(()=>reject(Error('Stall-start announcement timed out')),6000)})])}
 finally{clearTimeout(startTimer)}
 const captures=[]
 for(let i=0;i<2;i++) {
  await new Promise(resolve=>setTimeout(resolve,i?20:25))
  captures.push(await application.evaluate(async({BrowserWindow})=>{
   const requested=Date.now(),picture=await BrowserWindow.getAllWindows()[0].webContents.capturePage({x:350,y:370,width:1000,height:160})
   return {requested,completed:Date.now(),png:picture.toPNG().toString('base64')}
  }))
 }
 const stall=await busy;busy=null
 const after=await readSurface();assert.equal(stableForegroundSample(before,after),true)
 const imageResults=await page.evaluate(async captures=>Promise.all(captures.map(async capture=>{
  const image=new Image();image.src='data:image/png;base64,'+capture.png;await image.decode()
  const surface=new OffscreenCanvas(image.width,image.height),context=surface.getContext('2d',{willReadFrequently:true})
  context.drawImage(image,0,0);const pixels=context.getImageData(0,0,image.width,image.height).data
  let mass=0,xmass=0
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
   const p=(y*image.width+x)*4,weight=Math.max(0,pixels[p]+pixels[p+1]+pixels[p+2]-57)
   if(weight>10){mass+=weight;xmass+=weight*x}
  }
  return {requested:capture.requested,completed:capture.completed,centroid:(xmass/mass)*1000/image.width,mass}
 })),captures)
 for(const [i,capture]of captures.entries()) {
  await fs.writeFile(path.join(evidence,`capture-${i}.png`),Buffer.from(capture.png,'base64'))
 }
 const result={before,after,stall,captures:imageResults,rasterizationRequested:rasterization,desktopControlToolsUsed:false,
  interpretation:'Two independent Electron compositor captures during a blocked renderer. Not FPS/scanout timing; captures themselves are intrusive.'}
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2))
 console.log(JSON.stringify({evidence,rasterization:before.rendererFeatures.rasterization,blockedMs:stall.end-stall.start,
  stallStartedAfterMotionMs:stall.start-stall.motionStart,captures:imageResults,centroidAdvance:imageResults[1].centroid-imageResults[0].centroid}))
 if(rasterization==='gpu')assert.ok(before.rendererFeatures.rasterization.startsWith('enabled'))
 if(rasterization==='cpu'||(rasterization==='default'&&process.platform==='win32'))assert.equal(before.rendererFeatures.rasterization,'disabled_software')
 assert.ok(imageResults.every(c=>c.requested>=stall.start&&c.completed<stall.end),'both composited captures must complete while renderer JavaScript is blocked')
 assert.ok(imageResults[1].centroid-imageResults[0].centroid>80,'worker content must visibly advance while the main renderer is blocked')
}finally {
 try {await busy?.catch(()=>{});await page?.evaluate(()=>{window.surfaceProbe?.stop();window.surfaceProbeMovement?.cancel()}).catch(()=>{})}finally{
  try{await application?.close()}finally{try{await server?.close()}finally{
   assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('rms-native-worker-surface-'))
   await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200})
  }}
 }
}
