import assert from 'node:assert/strict'

// Independent direct pixel-box integration, not a second prefix implementation.
// Exercises arbitrary directions and the actual source-over crossfade equation.
export async function checkMotionIntegralMath(page, label) {
  const result = await page.evaluate(async () => {
    const { rowIntegrals, integralVertex, integralFragment } = await import('/src/discardMotion/integral.ts')
    const width = 11, height = 13, output = new OffscreenCanvas(256, 192)
    const gl = output.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true })
    if (!gl) throw Error('Integral math WebGL2 unavailable')
    const a = new Uint8ClampedArray(width * height * 4), b = new Uint8ClampedArray(a.length)
    let seed = 13
    const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed >>> 24 }
    for (const pixels of [a,b]) for (let i = 0; i < pixels.length; i++) pixels[i] = random()
    const shaders = [], textures = []
    const program = gl.createProgram()
    try {
      for (const [kind, text] of [[gl.VERTEX_SHADER,integralVertex],[gl.FRAGMENT_SHADER,integralFragment]]) {
        const shader = gl.createShader(kind); shaders.push(shader); gl.shaderSource(shader,text); gl.compileShader(shader)
        if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader))
        gl.attachShader(program,shader)
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program))
      gl.useProgram(program)
      const prefixes = [rowIntegrals(a,width,height),rowIntegrals(b,width,height),rowIntegrals(a,width,height,b)]
      for (const [unit,name] of ['planeA','planeB','product'].entries()) {
        const texture = gl.createTexture(); textures.push(texture)
        gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,texture)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,width+1,height,0,gl.RGBA,gl.FLOAT,prefixes[unit])
        gl.uniform1i(gl.getUniformLocation(program,name),unit)
      }
      gl.viewport(0,0,output.width,output.height)
      gl.uniform2f(gl.getUniformLocation(program,'sprite'),width,height)
      gl.uniform2f(gl.getUniformLocation(program,'viewport'),output.width,output.height)
      const cx=128.25,cy=96.5
      gl.uniform2f(gl.getUniformLocation(program,'center'),cx,cy)
      const cases=[]
      for (const degrees of [0,23,90,179]) for (const span of [0,.3,6.06,18.18,120]) for (const weights of [[1,0,0],[.7,.3,0],[.4,.6,.24]]) {
        const radians=degrees*Math.PI/180,ux=Math.cos(radians),uy=Math.sin(radians)
        gl.uniform2f(gl.getUniformLocation(program,'axis'),ux,uy)
        gl.uniform1f(gl.getUniformLocation(program,'span'),span)
        gl.uniform3f(gl.getUniformLocation(program,'weights'),...weights)
        gl.drawArrays(gl.TRIANGLES,0,3)
        const pixels=new Uint8Array(output.width*output.height*4)
        gl.readPixels(0,0,output.width,output.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
        let maxError=0, comparisons=0
        for (let py=0;py<output.height;py+=5) for (let px=0;px<output.width;px+=5) {
          const qx=px+.5-cx,qy=py+.5-cy,x=qx*ux+qy*uy+width/2,y=-qx*uy+qy*ux+height/2
          const n=Math.max(1,span),left=x+(span-n)/2,right=left+n,y0=Math.floor(y-.5),fy=y-.5-y0,sum=[0,0,0,0]
          for (let iy=y0;iy<=y0+1;iy++) if (iy>=0&&iy<height) {
            const wy=iy===y0?1-fy:fy
            for (let ix=Math.max(0,Math.floor(left));ix<Math.min(width,Math.ceil(right));ix++) {
              const box=Math.max(0,Math.min(right,ix+1)-Math.max(left,ix))*wy/n,i=(iy*width+ix)*4,aa=a[i+3]/255,ba=b[i+3]/255
              for (let c=0;c<4;c++) {
                const av=c===3?aa:a[i+c]/255*aa,bv=c===3?ba:b[i+c]/255*ba
                sum[c]+=box*(weights[0]*av+weights[1]*bv-weights[2]*av*ba)
              }
            }
          }
          // Independent full-row accumulation, not a second prefix sampler.
          const extent=Math.max(width,span),middle=(width-span)/2
          const covered=Math.max(0,Math.min(1,Math.min(x+.5,middle+extent/2)-Math.max(x-.5,middle-extent/2)))
          const ratio=Math.max(0,Math.min(1,span/width)),blend=ratio*ratio*(3-2*ratio),row=[0,0,0,0]
          for(let iy=y0;iy<=y0+1;iy++)if(iy>=0&&iy<height){
            const wy=iy===y0?1-fy:fy
            for(let ix=0;ix<width;ix++){
              const i=(iy*width+ix)*4,aa=a[i+3]/255,ba=b[i+3]/255
              for(let c=0;c<4;c++){
                const av=c===3?aa:a[i+c]/255*aa,bv=c===3?ba:b[i+c]/255*ba
                row[c]+=wy*(weights[0]*av+weights[1]*bv-weights[2]*av*ba)
              }
            }
          }
          for(let c=0;c<4;c++)sum[c]=sum[c]*(1-blend)+row[c]*covered/extent*blend
          const index=((output.height-1-py)*output.width+px)*4
          for (let c=0;c<4;c++) { maxError=Math.max(maxError,Math.abs(pixels[index+c]-Math.round(Math.max(0,Math.min(1,sum[c]))*255)));comparisons++ }
        }
        cases.push({degrees,span,weights,maxError,comparisons,glError:gl.getError()})
      }
      return cases
    } finally {
      textures.forEach(t=>gl.deleteTexture(t));shaders.forEach(s=>gl.deleteShader(s));gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  })
  for (const sample of result) {
    assert.ok(sample.maxError<=1, `${label}: independent crossfade/diagonal integral: ${JSON.stringify(sample)}`)
    assert.equal(sample.glError,0)
  }
  return {label,cases:result.length,maxError:Math.max(...result.map(s=>s.maxError)),comparisons:result.reduce((n,s)=>n+s.comparisons,0)}
}
