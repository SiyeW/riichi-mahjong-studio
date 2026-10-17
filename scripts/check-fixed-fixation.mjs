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
    const margin=W*.25/2+1
    const values=row.slice(Math.ceil(240.25-span+margin),Math.floor(240.25-margin))
    plateaus.push({span,min:Math.min(...values),max:Math.max(...values),massRatio:mass/(W*H)})
   }
   const a=draw(60,160.25),b=draw(90,250.25)
   // Constant speed, unequal actual hold intervals: compare light*time, not
   // an unweighted sum of images or a universal human-persistence duration.
   const held=a.row.map((value,x)=>value*6+b.row[x]*9)
   const interior=held.slice(104,247)
   const edge=draw(60,240.25).row.slice(177,185)
   const sequence={min:Math.min(...interior),max:Math.max(...interior),expected:2,
    outsideCenterCell:a.row[95]+b.row[255],join:held[160]}
   const ease=parseCssEasing('cubic-bezier(.33,1,.68,1)'),cadence=[0,6.06,18.18,48,54,89,110],irregular=[]
   for(let i=1;i<cadence.length;i++){
    const previous=40+300*ease(cadence[i-1]/110),current=40+300*ease(cadence[i]/110),span=current-previous
    const {row,mass}=draw(span,current)
    const values=row.slice(Math.ceil(previous+1),Math.floor(current-1))
    irregular.push({from:cadence[i-1],to:cadence[i],span,massRatio:mass/(W*H),minimum:values.length?Math.min(...values):null})
   }
   const landing=draw(0,340),nativeWidth=landing.row.filter(alpha=>alpha===1).length
   return{plateaus,sequence,edge,irregular,landing:{nativeWidth,massRatio:landing.mass/(W*H)},glError:gl.getError()}
  }finally{if(texture)gl.deleteTexture(texture);shaders.forEach(shader=>gl.deleteShader(shader));gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext()}
 })
 for(const p of result.plateaus){assert.ok(p.max-p.min<=1/255,`${label}: long-step single-frame plateau ${JSON.stringify(p)}`);assert.ok(Math.abs(p.massRatio-1)<.02)}
 assert.ok(result.sequence.max-result.sequence.min<.04,`${label}: unequal hold-time joins ${JSON.stringify(result.sequence)}`)
 assert.ok(Math.abs(result.sequence.join-result.sequence.expected)<.04)
 assert.equal(result.sequence.outsideCenterCell,0,'long-step reconstruction must not double-fill expanded adjacent footprints')
 assert.ok(result.edge.filter(a=>a>0&&a<.32).length>=3,`${label}: long interval edges must be visibly soft, not a one-pixel cut`)
 for(let i=1;i<result.edge.length;i++)assert.ok(result.edge[i]>=result.edge[i-1],`${label}: no secondary edge lobe`)
 for(const p of result.irregular){assert.ok(Math.abs(p.massRatio-1)<.025,`${label}: irregular cadence mass ${JSON.stringify(p)}`);if(p.minimum!==null)assert.ok(p.minimum>0)}
 assert.equal(result.landing.nativeWidth,20);assert.equal(result.landing.massRatio,1);assert.equal(result.glError,0)
 return{label,fixedFixation:result,interpretation:'GPU pixels and declared hold-time controls; not a validated human visual model or presented FPS'}
}
