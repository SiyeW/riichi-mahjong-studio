/** Zero prefix, pixel prefixes, then one support-metadata texel per row. */
export const ROW_INTEGRAL_PADDING = 2

export function rowSupport(pixels: Uint8ClampedArray, width: number, height: number,
  other?: Uint8ClampedArray): Uint32Array {
  if (pixels.length !== width * height * 4 || (other && other.length !== pixels.length)) throw Error('Invalid motion plane')
  const bounds = new Uint32Array(height * 2)
  for (let y = 0; y < height; y++) {
    let left = width, right = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4 + 3
      if (pixels[i] || other?.[i]) { left = Math.min(left, x); right = x + 1 }
    }
    bounds[y * 2] = left; bounds[y * 2 + 1] = right
  }
  return bounds
}

/** Premultiplied integrals and exact nonzero support; no alpha cutoff. */
export function rowIntegrals(pixels: Uint8ClampedArray, width: number, height: number,
  overAlpha?: Uint8ClampedArray, support = rowSupport(pixels, width, height)): Float32Array {
  if (pixels.length !== width * height * 4 || (overAlpha && overAlpha.length !== pixels.length)) throw Error('Invalid motion plane')
  if (support.length !== height * 2) throw Error('Invalid motion support')
  const stride = width + ROW_INTEGRAL_PADDING
  const result = new Float32Array(stride * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, p = (y * stride + x) * 4
    const alpha = pixels[i + 3]! / 255 * (overAlpha ? overAlpha[i + 3]! / 255 : 1)
    for (let c = 0; c < 4; c++) result[p + 4 + c] = result[p + c]! + (c === 3 ? alpha : pixels[i + c]! / 255 * alpha)
  }
  for (let y = 0; y < height; y++) {
    const p = (y * stride + width + 1) * 4
    result[p] = support[y * 2]!; result[p + 1] = support[y * 2 + 1]!
  }
  return result
}

export interface OpacityStop { offset: number; value: number }
export function opacityAt(stops: readonly OpacityStop[], progress: number): number {
  if (!stops.length) return 1
  if (progress <= stops[0]!.offset) return stops[0]!.value
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!
    if (progress <= b.offset) return a.value + (b.value - a.value) * (progress - a.offset) / (b.offset - a.offset)
  }
  return stops.at(-1)!.value
}

export const integralVertex = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`

export const integralFragment = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D planeA; uniform sampler2D planeB; uniform sampler2D product;
uniform vec2 sprite; uniform vec2 viewport; uniform vec2 center; uniform vec2 axis;
uniform float span; uniform vec3 weights;
out vec4 color;
// Shared support makes reconstruction linear in the composited prefix. Apply
// face/back weights here so geometry and reflection run once, not per plane.
vec4 prefix(int x,int y){
  ivec2 p=ivec2(x,y);vec4 value=weights.x*texelFetch(planeA,p,0);
  if(weights.y>0.)value+=weights.y*texelFetch(planeB,p,0);
  if(weights.z>0.)value-=weights.z*texelFetch(product,p,0);
  return value;
}
vec4 line(float x,int y){
  if(y<0||y>=int(sprite.y))return vec4(0.);
  float p=clamp(x,0.,sprite.x);int a=int(floor(p));int b=min(a+1,int(sprite.x));
  return mix(prefix(a,y),prefix(b,y),fract(p));
}
vec4 integral(float x,float y){float r=y-.5;int a=int(floor(r));return mix(line(x,a),line(x,a+1),fract(r));}
// Reflect a row at its actual artwork boundaries. A window of twice the row
// width averages one complete reflected period, independent of its position.
// This keeps short-step smoothing inside the artwork, without mixing a wide
// faded footprint with a narrower rectangular one. Cost is independent of span.
vec4 reflected(float x,int y,vec2 bounds,vec4 total){
  float w=bounds.y-bounds.x,cycle=floor(x/(2.*w)),r=x-cycle*2.*w;
  return cycle*2.*total+(r<=w?line(bounds.x+r,y):2.*total-line(bounds.x+2.*w-r,y));
}
// Antiderivative of a smooth cumulative edge. Taking its pixel difference
// antialiases the soft interval; neighboring long intervals have complementary
// edges, instead of separately faded, overlapping copies of the artwork.
float softIntegral(float x,float width){
  if(width<.0001)return max(x,0.);
  float t=clamp(x/width+.5,0.,1.);
  return max(x-width*.5,0.)+width*(t*t*t-.5*t*t*t*t);
}
float softCoverage(float x,float extent,float width){
  return clamp(softIntegral(x+.5,width)-softIntegral(x-.5,width)
    -softIntegral(x-extent+.5,width)+softIntegral(x-extent-.5,width),0.,1.);
}
vec4 sweepRow(float x,int y){
  if(y<0||y>=int(sprite.y))return vec4(0.);
  vec2 bounds=texelFetch(planeA,ivec2(int(sprite.x)+1,y),0).xy;
  float w=bounds.y-bounds.x;
  if(w<=0.)return vec4(0.);
  float extent=max(w,span);
  float offset=(bounds.x+bounds.y-sprite.x)*.5*(1.-smoothstep(0.,w,span));
  float q=x-(sprite.x-span)*.5-offset+extent*.5;
  float softness=min(span*.5,w*.25);
  float coverage=softCoverage(q,extent,softness);
  if(coverage==0.)return vec4(0.);
  // Long updates partition the center trajectory. This is display
  // reconstruction, not physical shutter exposure.
  vec4 total=prefix(int(bounds.y),y);
  if(span>=w)return total*(coverage/extent);
  float n=min(2.*w,max(1.,2.*span));
  return (reflected(q+n*.5,y,bounds,total)-reflected(q-n*.5,y,bounds,total))*(coverage/n);
}
vec4 sweep(vec2 p){
  if(span==0.)return integral(p.x+.5,p.y)-integral(p.x-.5,p.y);
  float r=p.y-.5;int y=int(floor(r));
  return mix(sweepRow(p.x,y),sweepRow(p.x,y+1),fract(r));
}
void main(){
  vec2 q=vec2(gl_FragCoord.x,viewport.y-gl_FragCoord.y)-center;
  vec2 p=vec2(dot(q,axis),dot(q,vec2(-axis.y,axis.x)))+sprite*.5;
  color=clamp(sweep(p),0.,1.);
}`
