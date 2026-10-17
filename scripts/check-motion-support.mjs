import assert from 'node:assert/strict'

// Actual decorated artwork on two contrasting table surfaces. Test transparent
// exterior pixels as well as interior mass; the generated sheets need inspection.
export async function checkMotionSupport(page, label, evidence) {
  const result = await page.evaluate(async () => {
    const { captureMotionSnapshot } = await import('/src/discardMotion/snapshot.ts')
    const { integralVertex, integralFragment, rowIntegrals, ROW_INTEGRAL_PADDING } = await import('/src/discardMotion/integral.ts')
    const dpr=devicePixelRatio,output = new OffscreenCanvas(Math.round(360*dpr),Math.round(280*dpr))
    const gl = output.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true})
    if (!gl) throw Error('Artwork support GL unavailable')
    const program=gl.createProgram(),textures=[],shaders=[],cases=[],sheets=[]
    try {
      for(const[kind,text]of[[gl.VERTEX_SHADER,integralVertex],[gl.FRAGMENT_SHADER,integralFragment]]){
        const shader=gl.createShader(kind);shaders.push(shader);gl.shaderSource(shader,text);gl.compileShader(shader)
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));gl.attachShader(program,shader)
      }
      gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program)
      const u=name=>gl.getUniformLocation(program,name),fractions=[0,.01,.1,.25,.5,.75,1,2]
      gl.viewport(0,0,output.width,output.height);gl.uniform2f(u('viewport'),output.width,output.height)
      for(const mode of ['face','overlay','crossfade']){
        const sheet=document.createElement('canvas');sheet.id=`motion-support-${mode}`;sheet.width=Math.round(2880*dpr);sheet.height=Math.round(1280*dpr)
        sheet.style.cssText='position:absolute;left:0;top:0;z-index:9999;width:1440px;height:640px'
        sheet.hidden=true;document.body.append(sheet);sheets.push(sheet.id)
        const ctx=sheet.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#02191e';ctx.fillRect(0,0,2880,1280)
        for(const[seat,angle]of[0,17,90,270].entries()){
          const source=document.createElement('div');source.className='tileDiv';source.style.cssText=`position:absolute;left:450px;top:400px;transform:rotate(${angle}deg)`
          source.innerHTML='<img class="tileImg last-discard" src="/src/assets/tiles/Regular_shortnames/5m.svg"><img class="tileImg last-discard" style="position:absolute;left:0;top:0" src="/src/assets/tiles/Regular_shortnames/back.svg">'
          document.body.append(source);const [face,back]=source.querySelectorAll('img');await Promise.all([face.decode(),back.decode()])
          if(mode==='crossfade')back.style.transform='rotate(90deg)'
          const effects=mode==='face'?[]:mode==='overlay'?[back.animate([{opacity:0},{opacity:1}],{duration:1,fill:'both'})]
            :[face.animate([{opacity:1},{opacity:0}],{duration:1,fill:'both'}),back.animate([{opacity:0},{opacity:1}],{duration:1,fill:'both'})]
          effects.forEach(effect=>{effect.pause();effect.currentTime=0})
          if(mode==='face')back.style.display='none'
          let snapshot
          try{
            snapshot=await captureMotionSnapshot(source,effects,300,95)
            if(mode==='face'){
              back.remove()
              const visibleOnly=await captureMotionSnapshot(source,[],300,95)
              if(JSON.stringify(snapshot.geometry)!==JSON.stringify(visibleOnly.geometry)
                ||snapshot.pixels.some((value,index)=>value!==visibleOnly.pixels[index]))throw Error('Hidden artwork changed the visible crop or pixels')
            }
          }finally{effects.forEach(effect=>effect.cancel());source.remove()}
          const g=snapshot.geometry,bytes=g.spriteWidth*g.spriteHeight*4,a=snapshot.pixels.subarray(0,bytes),b=mode==='face'?a:snapshot.pixels.subarray(bytes)
          const support=new Uint32Array(g.spriteHeight*2),weights=mode==='face'?[1,0,0]:mode==='overlay'?[.5,.5,0]:[.4,.6,.24]
          // Test-only source bounds, never used to move or reshape the drawing.
          for(let y=0;y<g.spriteHeight;y++){
            let left=g.spriteWidth,right=0
            for(let x=0;x<g.spriteWidth;x++)if(a[(y*g.spriteWidth+x)*4+3]||b[(y*g.spriteWidth+x)*4+3]){left=Math.min(left,x);right=x+1}
            support[y*2]=left;support[y*2+1]=right
          }
          textures.forEach(texture=>gl.deleteTexture(texture));textures.length=0
          const prefixes=[rowIntegrals(a,g.spriteWidth,g.spriteHeight),rowIntegrals(b,g.spriteWidth,g.spriteHeight),rowIntegrals(a,g.spriteWidth,g.spriteHeight,b)]
          for(const[unit,name]of['planeA','planeB','product'].entries()){
            const texture=gl.createTexture();textures.push(texture);gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture)
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,g.spriteWidth+ROW_INTEGRAL_PADDING,g.spriteHeight,0,gl.RGBA,gl.FLOAT,prefixes[unit]);gl.uniform1i(u(name),unit)
          }
          gl.uniform2f(u('sprite'),g.spriteWidth,g.spriteHeight);gl.uniform2f(u('axis'),g.axisX,g.axisY);gl.uniform3f(u('weights'),...weights)
          let nativeMass=0
          for(const[column,fraction]of fractions.entries()){
            const span=fraction*g.spriteWidth,cx=output.width/2+span*g.axisX/2,cy=output.height/2+span*g.axisY/2
            gl.uniform2f(u('center'),cx,cy);gl.uniform1f(u('span'),span);gl.drawArrays(gl.TRIANGLES,0,3)
            const data=new Uint8Array(output.width*output.height*4);gl.readPixels(0,0,output.width,output.height,gl.RGBA,gl.UNSIGNED_BYTE,data)
            let mass=0,exterior=0,maxPremultipliedError=0,rigidPixelMaxError=0,activeComparisons=0
            const image=new Uint8ClampedArray(data.length)
            for(let y=0;y<output.height;y++)for(let x=0;x<output.width;x++){
              const i=(y*output.width+x)*4,j=((output.height-1-y)*output.width+x)*4,alpha=data[j+3]
              mass+=alpha/255;image[i+3]=alpha
              for(let c=0;c<3;c++){image[i+c]=alpha?Math.round(data[j+c]*255/alpha):0;maxPremultipliedError=Math.max(maxPremultipliedError,data[j+c]-alpha)}
              const qx=x+.5-cx,qy=y+.5-cy,px=qx*g.axisX+qy*g.axisY+g.spriteWidth/2,py=-qx*g.axisY+qy*g.axisX+g.spriteHeight/2
              const row=Math.floor(py-.5)
              const outside=iy=>{
                if(iy<0||iy>=g.spriteHeight)return true
                const left=support[iy*2],right=support[iy*2+1],n=Math.max(1,span),sampleLeft=px+(span-n)/2
                return right<=left||sampleLeft+n<=left||sampleLeft>=right
              }
              if(outside(row)&&outside(row+1))exterior=Math.max(exterior,alpha)
              if(x%Math.round(9*dpr)===0&&y%Math.round(9*dpr)===0){
                // Literal rigid source-pixel translations, independent of the
                // GPU prefix implementation and of the rejected row reshaping.
                const n=Math.max(1,span),left=px+(span-n)/2,right=left+n,fy=py-.5-row,expected=[0,0,0,0]
                for(let iy=row;iy<=row+1;iy++)if(iy>=0&&iy<g.spriteHeight){
                  const wy=iy===row?1-fy:fy
                  for(let ix=Math.max(0,Math.floor(left));ix<Math.min(g.spriteWidth,Math.ceil(right));ix++){
                    const k=(iy*g.spriteWidth+ix)*4,aa=a[k+3]/255,ba=b[k+3]/255,weight=wy*Math.max(0,Math.min(right,ix+1)-Math.max(left,ix))/n
                    for(let c=0;c<4;c++){
                      const av=c===3?aa:a[k+c]/255*aa,bv=c===3?ba:b[k+c]/255*ba
                      expected[c]+=weight*(weights[0]*av+weights[1]*bv-weights[2]*av*ba)
                    }
                  }
                }
                if(expected[3]>.01)activeComparisons++
                for(let c=0;c<4;c++)rigidPixelMaxError=Math.max(rigidPixelMaxError,Math.abs(data[j+c]-Math.round(Math.max(0,Math.min(1,expected[c]))*255)))
              }
            }
            if(!column)nativeMass=mass
            cases.push({mode,angle,fraction,exterior,massRatio:mass/nativeMass,maxPremultipliedError,rigidPixelMaxError,activeComparisons,glError:gl.getError()})
            // Unpremultiply only for this 2D diagnostic consumer, never in the
            // production premultiplied renderer. Avoid a PNG encode/decode loop.
            const tile=new OffscreenCanvas(output.width,output.height);tile.getContext('2d').putImageData(new ImageData(image,output.width,output.height),0,0)
            const x=column*360,y=seat*320
            ctx.fillStyle='#02191e';ctx.fillRect(x,y,360,170);ctx.fillStyle='#0b4955';ctx.fillRect(x,y+170,360,150)
            ctx.fillStyle='#d7e3e3';ctx.font='14px sans-serif';ctx.fillText(`${mode} ${angle}° / ${fraction} width`,x+5,y+18)
            ctx.drawImage(tile,x,y+35,360,280)
          }
        }
      }
      return {cases,sheets}
    }finally{textures.forEach(t=>gl.deleteTexture(t));shaders.forEach(s=>gl.deleteShader(s));gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext()}
  })
  try {
    for(const item of result.cases){
      assert.equal(item.exterior,0,`${label}: no pixels beyond the rigid swept footprint ${JSON.stringify(item)}`)
      assert.ok(item.rigidPixelMaxError<=1,`${label}: preserve whole-source rigid geometry ${JSON.stringify(item)}`)
      assert.ok(item.activeComparisons>10,`${label}: compare real artwork, not only empty background ${JSON.stringify(item)}`)
      assert.ok(Math.abs(item.massRatio-1)<.03,`${label}: artwork mass ${JSON.stringify(item)}`)
      assert.ok(item.maxPremultipliedError<=1,`${label}: premultiplied color ${JSON.stringify(item)}`)
      assert.equal(item.glError,0)
    }
    if(evidence)for(const id of result.sheets){
      await page.locator(`#${id}`).evaluate(canvas=>{canvas.hidden=false})
      await page.locator(`#${id}`).screenshot({path:`${evidence}/${label}-${id}.png`})
      await page.locator(`#${id}`).evaluate(canvas=>{canvas.hidden=true})
    }
  }finally{await page.evaluate(ids=>ids.forEach(id=>document.getElementById(id)?.remove()),result.sheets)}
  return {label,artworkSupport:result.cases}
}
