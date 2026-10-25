import assert from 'node:assert/strict'

export async function checkFixedFixation(page,label) {
 const result=await page.evaluate(async()=>{
  const {integralVertex,integralFragment,rowIntegrals,ROW_INTEGRAL_PADDING}=await import('/src/discardMotion/integral.ts')
  const {parseCssEasing}=await import('/src/motionCurve.ts')
  const W=20,H=10,canvas=new OffscreenCanvas(500,40)
  const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true})
  if(!gl)throw Error('Fixed-fixation GL unavailable')
  const program=gl.createProgram(),shaders=[]
  let texture
  try{
   for(const[kind,text]of[[gl.VERTEX_SHADER,integralVertex],[gl.FRAGMENT_SHADER,integralFragment]]){
    const shader=gl.createShader(kind);shaders.push(shader);gl.shaderSource(shader,text);gl.compileShader(shader)
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader))
    gl.attachShader(program,shader)
   }
   gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program)
   texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
   gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,W+ROW_INTEGRAL_PADDING,H,0,gl.RGBA,gl.FLOAT,rowIntegrals(new Uint8ClampedArray(W*H*4).fill(255),W,H))
   const u=name=>gl.getUniformLocation(program,name)
   for(const name of ['planeA','planeB','product'])gl.uniform1i(u(name),0)
   gl.uniform2f(u('sprite'),W,H);gl.uniform2f(u('viewport'),canvas.width,canvas.height);gl.uniform2f(u('axis'),1,0);gl.uniform3f(u('weights'),1,0,0);gl.viewport(0,0,canvas.width,canvas.height)
   const draw=(span,center)=>{
    gl.uniform1f(u('span'),span);gl.uniform2f(u('center'),center,20);gl.drawArrays(gl.TRIANGLES,0,3)
    const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
    const row=Array.from({length:canvas.width},(_,x)=>pixels[(20*canvas.width+x)*4+3]/255)
    let mass=0;for(let i=3;i<pixels.length;i+=4)mass+=pixels[i]/255
    return{row,mass}
   }
   const plateaus=[]
   for(const span of [W,W*3,W*6]){
    const {row,mass}=draw(span,240.25)
    const margin=W/2+1
    const values=row.slice(Math.ceil(240.25-span+margin),Math.floor(240.25-margin))
    plateaus.push({span,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null,massRatio:mass/(W*H)})
   }
   const a=draw(60,160.25),b=draw(90,250.25)
   // Constant speed, unequal actual hold intervals: compare light*time, not
   // an unweighted sum of images or a universal human-persistence duration.
   const held=a.row.map((value,x)=>value*6+b.row[x]*9),union=draw(150,250.25)
   const unionError=Math.max(...union.row.map((value,x)=>Math.abs((a.row[x]*60+b.row[x]*90)/150-value)))
   const interior=held.slice(112,239)
   const edge=draw(60,240.25).row.slice(177,185)
   const sequence={min:Math.min(...interior),max:Math.max(...interior),expected:2,
    outsideFootprint:a.row[85]+b.row[265],outerGradient:a.row[95],join:held[160],unionError}
   const joinA=draw(60,160.5),joinB=draw(90,250.5)
   const complementaryEdges=[155,160,165].map(x=>({x,
    outgoing:joinA.row[x]/(W/60),incoming:joinB.row[x]/(W/90)}))
   const ease=parseCssEasing('cubic-bezier(.33,1,.68,1)'),cadence=[0,6.06,18.18,48,54,89,110],irregular=[]
   for(let i=1;i<cadence.length;i++){
    const previous=40+300*ease(cadence[i-1]/110),current=40+300*ease(cadence[i]/110),span=current-previous
    const {row,mass}=draw(span,current)
    const values=row.slice(Math.ceil(previous+1),Math.floor(current-1))
    irregular.push({from:cadence[i-1],to:cadence[i],span,massRatio:mass/(W*H),minimum:values.length?Math.min(...values):null})
   }
   const landing=draw(0,340),nativeWidth=landing.row.filter(alpha=>alpha===1).length
   return{plateaus,sequence,complementaryEdges,edge,irregular,landing:{nativeWidth,massRatio:landing.mass/(W*H)},glError:gl.getError()}
  }finally{if(texture)gl.deleteTexture(texture);shaders.forEach(shader=>gl.deleteShader(shader));gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext()}
 })
 for(const p of result.plateaus){if(p.min!==null)assert.ok(p.max-p.min<=1/255,`${label}: long-step interior plateau ${JSON.stringify(p)}`);assert.ok(Math.abs(p.massRatio-1)<.02)}
 // Each 8-bit image is rounded by at most half a code value, then weighted by
 // its 6ms/9ms dwell. Bound that quantization, not an arbitrary profile tolerance.
 const quantization=(6+9)/(2*255)+1e-8
 assert.ok(Math.abs(result.sequence.min-result.sequence.expected)<=quantization
   &&Math.abs(result.sequence.max-result.sequence.expected)<=quantization,`${label}: unequal hold-time joins ${JSON.stringify(result.sequence)}`)
 assert.ok(Math.abs(result.sequence.join-result.sequence.expected)<=quantization)
 assert.equal(result.sequence.outsideFootprint,0,'no pixels beyond the rigid swept footprint')
 assert.ok(result.sequence.outerGradient>0,'soft ends must extend outward, not contract at the previous center')
 assert.ok(result.sequence.unionError<=1/255+1e-8,`${label}: overlapping adjacent integrals must equal their continuous union`)
 const edgeQuantization=(60+90)/(2*20*255)+1e-8
 for(const point of result.complementaryEdges)assert.ok(Math.abs(point.outgoing+point.incoming-1)<=edgeQuantization,
   `${label}: the whole overlap must be complementary ${JSON.stringify(point)}`)
 const midpoint=result.complementaryEdges[1]
 assert.ok(Math.abs(midpoint.outgoing-.5)<=60/(2*20*255)+1e-8
   &&Math.abs(midpoint.incoming-.5)<=90/(2*20*255)+1e-8,`${label}: midpoint is half/half, within pixel quantization`)
 assert.ok(result.edge.filter(a=>a>0&&a<.32).length>=3,`${label}: long interval edges must be visibly soft, not a one-pixel cut`)
 for(let i=1;i<result.edge.length;i++)assert.ok(result.edge[i]>=result.edge[i-1],`${label}: no secondary edge lobe`)
 for(const p of result.irregular){assert.ok(Math.abs(p.massRatio-1)<.025,`${label}: irregular cadence mass ${JSON.stringify(p)}`);if(p.minimum!==null)assert.ok(p.minimum>0)}
 assert.equal(result.landing.nativeWidth,20);assert.equal(result.landing.massRatio,1);assert.equal(result.glError,0)
 return{label,fixedFixation:result,interpretation:'GPU pixels and declared hold-time controls; not a validated human visual model or presented FPS'}
}
