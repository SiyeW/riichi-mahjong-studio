import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import { checkMotionIntegralMath } from './check-motion-integral-math.mjs'
import { checkMotionWorkerFailures } from './check-motion-worker-failures.mjs'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-coverage-check-'))
const evidence = path.join(root, '.mjai-runtime', 'discard-coverage')
fs.mkdirSync(evidence, { recursive: true })
let server, browser, desktop
const results = []
const externalRendererUrl = process.env.RMS_COVERAGE_TEST_URL || null
let rendererUrl

async function check(page, label, dense) {
  await page.setViewportSize({ width: 1000, height: 850 })
  await page.goto(`${rendererUrl}scripts/visual-tests/discard-motion/index.html`)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.evaluate(async () => {
    ;(await import('/scripts/visual-tests/discard-motion/preview.ts')).dispose()
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/src/components/TableRivers.css?direct'
    const loaded = new Promise(resolve => { css.onload = resolve }); document.head.append(css); await loaded
    document.body.innerHTML = ''
    document.body.style.cssText = 'background:#02191e;margin:0;overflow:hidden;--zoom:1.5'
    window.snapshotApi = await import('/src/discardMotion/snapshot.ts')
    window.integralApi = await import('/src/discardMotion/integral.ts')
    window.coverageApi = await import('/src/discardMotion/coverage.ts')
  })
  for (const seat of dense ? [0,1,2,3] : [3]) for (const riichi of [false,true]) for (const reverse of [false,true]) {
    const clip = await page.evaluate(async ({seat, riichi, reverse}) => {
      document.body.innerHTML = `<div class="pov-p${seat}" style="position:absolute;left:450px;top:400px"><div class="river-row"><div class="tileDiv ${riichi ? 'river-riichi' : ''}"><img class="tileImg" src="/src/assets/tiles/Regular_shortnames/5m.svg"></div></div></div>`
      const source = document.querySelector('.tileDiv'), image = source.querySelector('img'); await image.decode()
      const rect = image.getBoundingClientRect()
      window.motionSource = source
      window.motionDelta = { dx: Math.cos(seat*Math.PI/2)*280*(reverse ? -1 : 1), dy: Math.sin(seat*Math.PI/2)*280*(reverse ? -1 : 1) }
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height}
    }, {seat,riichi,reverse})
    const native = await page.screenshot({clip})
    const preparation = await page.evaluate(async () => {
      const began = performance.now()
      const snapshot = await window.snapshotApi.captureMotionSnapshot(window.motionSource, [], window.motionDelta.dx, window.motionDelta.dy)
      window.motionSnapshot = snapshot
      const output = document.createElement('canvas'), {geometry:g,dpr,left,top} = snapshot
      output.width = g.width; output.height = g.height
      output.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${g.width/dpr}px;height:${g.height/dpr}px`
      document.body.append(output)
      const gl = output.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true})
      if (!gl) throw Error('WebGL2 unavailable')
      const compile = (kind,text) => { const shader=gl.createShader(kind);gl.shaderSource(shader,text);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader }
      const program=gl.createProgram(); const {integralVertex,integralFragment,rowIntegrals}=window.integralApi
      gl.attachShader(program,compile(gl.VERTEX_SHADER,integralVertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,integralFragment));gl.linkProgram(program)
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program)
      const pixels=snapshot.pixels.subarray(0,g.spriteWidth*g.spriteHeight*4)
      const prefix=rowIntegrals(pixels,g.spriteWidth,g.spriteHeight)
      for(const [unit,name] of ['planeA','planeB','product'].entries()) {
        const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,g.spriteWidth+1,g.spriteHeight,0,gl.RGBA,gl.FLOAT,prefix)
        gl.uniform1i(gl.getUniformLocation(program,name),unit)
      }
      gl.viewport(0,0,g.width,g.height)
      gl.uniform2f(gl.getUniformLocation(program,'sprite'),g.spriteWidth,g.spriteHeight)
      gl.uniform2f(gl.getUniformLocation(program,'viewport'),g.width,g.height)
      gl.uniform2f(gl.getUniformLocation(program,'axis'),g.axisX,g.axisY)
      gl.uniform3f(gl.getUniformLocation(program,'weights'),1,0,0)
      window.drawMotion = (span,progress=0) => {
        gl.uniform2f(gl.getUniformLocation(program,'center'),g.startX+g.dx*progress,g.startY+g.dy*progress)
        gl.uniform1f(gl.getUniformLocation(program,'span'),span);gl.drawArrays(gl.TRIANGLES,0,3);gl.finish()
      }
      window.drawMotion(0)
      window.motionSource.style.opacity='0'
      window.motionOutput=output; window.motionGl=gl
      return {ms:performance.now()-began,plane:[g.spriteWidth,g.spriteHeight],surface:[g.width,g.height]}
    })
    const sharp = await page.screenshot({clip})
    const error = await page.evaluate(async images => {
      const arrays=await Promise.all(images.map(async base64=>{const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();const c=new OffscreenCanvas(image.width,image.height),ctx=c.getContext('2d');ctx.drawImage(image,0,0);return {data:ctx.getImageData(0,0,c.width,c.height).data,width:c.width,height:c.height}}))
      let max=0,sum=0,flatMax=0
      const [a,b]=arrays
      for(let i=0;i<a.data.length;i++){const d=Math.abs(a.data[i]-b.data[i]);sum+=d;max=Math.max(max,d)}
      for(let y=3;y<a.height-3;y++)for(let x=3;x<a.width-3;x++)for(let c=0;c<3;c++){
        const i=(y*a.width+x)*4+c, values=[-3,0,3].flatMap(dy=>[-3,0,3].map(dx=>a.data[i+(dy*a.width+dx)*4]))
        if(Math.max(...values)-Math.min(...values)<3)flatMax=Math.max(flatMax,Math.abs(a.data[i]-b.data[i]))
      }
      return {max,mean:sum/a.data.length,flatMax}
    },[native.toString('base64'),sharp.toString('base64')])
    if (error.mean>=6 || error.flatMax>=5) {
      fs.writeFileSync(path.join(evidence,'failed-native.png'),native)
      fs.writeFileSync(path.join(evidence,'failed-integral.png'),sharp)
      console.log(await page.evaluate(()=>({geometry:window.motionSnapshot.geometry,source:window.motionSource.outerHTML,style:getComputedStyle(window.motionSource).cssText})))
    }
    // Fractional DPI can select another edge AA phase in the transient surface.
    // Opaque flat colors retain the tighter normalization bound. The actual
    // landing always restores the original native SVG, not this sampled pose.
    assert.ok(error.mean<6 && error.flatMax<5, `${label} canonical pose ${seat}/${riichi}/${reverse}: ${JSON.stringify(error)}`)
    const sweep = await page.evaluate(() => {
      const {geometry:g}=window.motionSnapshot, gl=window.motionGl
      const spans=[0,.3,6.06,18.18,120,280*devicePixelRatio]
      const read=()=>{const p=new Uint8Array(g.width*g.height*4);gl.readPixels(0,0,g.width,g.height,gl.RGBA,gl.UNSIGNED_BYTE,p);return p}
      const mass=p=>{let total=0;for(let i=0;i<p.length;i+=4)total+=p[i]+p[i+1]+p[i+2];return total}
      window.drawMotion(0,1);const sharpMass=mass(read())
      return spans.map(span=>{
        window.drawMotion(span,1);const pixels=read();let minimumAlpha=255
        for(let t=0;t<=100;t++){
          const x=Math.floor(g.startX+g.dx-g.axisX*span*t/100),y=Math.floor(g.startY+g.dy-g.axisY*span*t/100)
          const a=pixels[((g.height-1-y)*g.width+x)*4+3];minimumAlpha=Math.min(minimumAlpha,a??0)
        }
        return {span,minimumAlpha,massRatio:mass(pixels)/sharpMass,glError:gl.getError()}
      })
    })
    for(const sample of sweep) {
      assert.ok(sample.minimumAlpha>0, `${label}: no swept-centerline hole ${JSON.stringify(sample)}`)
      assert.ok(sample.massRatio>.99 && sample.massRatio<1.01, `${label}: normalized light mass ${JSON.stringify(sample)}`)
      assert.equal(sample.glError,0)
    }
    if(seat===3&&!riichi&&!reverse) await page.screenshot({path:path.join(evidence,`${label}.png`)})
    await page.evaluate(()=>{window.motionGl.getExtension('WEBGL_lose_context')?.loseContext()})
    results.push({label,seat,riichi,reverse,preparation,error,sweep})
  }
  results.push(await checkMotionIntegralMath(page,label))
  const lifecycle = await page.evaluate(async () => {
    window.motionOutput.remove(); window.motionSource.style.removeProperty('opacity')
    const renderer=window.coverageApi.createDiscardCoverageRenderer();renderer.start()
    const until=async test=>{const end=performance.now()+4000;while(!test()){if(performance.now()>end)throw Error('Worker warm/start timeout');await new Promise(r=>setTimeout(r,2))}}
    await until(()=>renderer.ready)
    const source=window.motionSource
    const make=()=>{const movement=source.animate([{transform:'translate(0px,0px)'},{transform:'translate(280px,0px)'}],{duration:110,easing:'cubic-bezier(0.33,1,0.68,1)',fill:'forwards'});return {movement,handle:renderer.prepare({source,effects:[],movement,duration:110,easing:'cubic-bezier(0.33,1,0.68,1)',dx:280,dy:0})}}
    const first=make();if(!first.handle)throw Error('Warm worker refused a flight')
    await until(()=>document.querySelector('.discard-flight-coverage'))
    const surface=document.querySelector('.discard-flight-coverage'), admissionMs=Number(surface.dataset.admissionMs)
    const busyStart=performance.timeOrigin+performance.now();while(performance.timeOrigin+performance.now()-busyStart<80){}
    const busyEnd=performance.timeOrigin+performance.now()
    await first.handle.finished
    const intervals=JSON.parse(surface.dataset.intervals||'[]')
    const duringStall=intervals.filter(p=>p.time>busyStart&&p.time<busyEnd).length
    if(!duringStall)throw Error('Worker did not advance during a main-thread stall')
    if(source.style.opacity)throw Error('Normal completion leaked source opacity')
    if(intervals.length<2||intervals.at(-1).span!==0||intervals.at(-1).progress!==1)throw Error('Landing did not draw sweep then sharp endpoint')
    for(let i=1;i<intervals.length;i++)if(intervals[i].previous!==intervals[i-1].progress
      ||intervals[i].fromTime!==intervals[i-1].time)throw Error('Skipped updates lost their previous submitted endpoint')
    if(intervals.some(p=>p.fromTime>p.time))throw Error('Cross-thread interval reversed its clock endpoints')
    first.movement.cancel()
    const cancelled=make();cancelled.handle.cancel();cancelled.movement.cancel();await cancelled.handle.finished
    await new Promise(r=>setTimeout(r,100))
    if(document.querySelector('.discard-flight-coverage')||source.style.opacity)throw Error('Stale preparation reactivated a retired flight')
    const resized=make();await until(()=>document.querySelector('.discard-flight-coverage'));window.dispatchEvent(new Event('resize'));await resized.handle.finished;resized.movement.cancel()
    if(source.style.opacity)throw Error('Resize did not restore source')
    const hidden=make();renderer.stop();hidden.movement.cancel();await hidden.handle.finished
    if(document.querySelector('.discard-motion-surface'))throw Error('Stop leaked surface/worker')
    return {admissionMs,duringStall,intervals}
  })
  results.push({label,lifecycle})
  results.push(await checkMotionWorkerFailures(page,label))
}

try {
  if (!externalRendererUrl) {
    server=await createServer({root,mode:'ui-test',cacheDir:path.join(temporary,'vite-cache'),optimizeDeps:{entries:['scripts/visual-tests/discard-motion/preview.ts']},server:{host:'127.0.0.1',port:0,strictPort:false}})
    await server.listen()
  }
  rendererUrl=externalRendererUrl || server.resolvedUrls.local[0]
  for(const [software,ratio] of [[false,1],[true,1],[false,1.25],[false,2]]) {
    browser=await chromium.launch({headless:true,args:software?['--disable-gpu']:[]})
    const page=await browser.newPage({deviceScaleFactor:ratio})
    await check(page,`${software?'software':'default'}-${ratio}`,ratio===1)
    await browser.close();browser=null
  }
  desktop=await electron.launch({args:[path.join(root,'scripts/electron-ui-test-main.cjs')],env:{...process.env,RMS_UI_TEST_URL:rendererUrl}})
  await check(await desktop.firstWindow(),'electron',false)
  fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(results,null,2))
  console.log(`Integral coverage passed: ${results.filter(r=>r.seat!==undefined).length} canonical poses, bounded sweeps and worker cancellation/landing/stall checks.`)
} finally {
  try {await desktop?.close()}finally {try {await browser?.close()}finally {try {await server?.close()}finally {fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200})}}}
}
const navigation=spawnSync(process.execPath,[path.join(root,'scripts/check-analysis-ui.mjs')],{cwd:root,stdio:'inherit',env:{...process.env,
  ...(externalRendererUrl?{RMS_UI_TEST_URL:externalRendererUrl}:{}),RMS_UI_DISCARD_ONLY:'1',RMS_UI_COVERAGE_TRIAL:'1'}})
if(navigation.error)throw navigation.error
process.exitCode=navigation.status??1
if(navigation.status===0) {
  const compiled=spawnSync(process.execPath,[path.join(root,'scripts/check-built-discard-coverage.mjs')],{cwd:root,stdio:'inherit',env:process.env})
  if(compiled.error)throw compiled.error
  process.exitCode=compiled.status??1
}
