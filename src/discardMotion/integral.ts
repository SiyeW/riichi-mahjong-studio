/** One zero prefix, followed by cumulative original pixels. No shape metadata. */
export const ROW_INTEGRAL_PADDING = 1

/** Premultiplied integrals; sampling cost never grows with trail length. */
export function rowIntegrals(pixels: Uint8ClampedArray, width: number, height: number,
  overAlpha?: Uint8ClampedArray): Float32Array {
  if (pixels.length !== width * height * 4 || (overAlpha && overAlpha.length !== pixels.length)) throw Error('Invalid motion plane')
  const stride = width + ROW_INTEGRAL_PADDING
  const result = new Float32Array(stride * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, p = (y * stride + x) * 4
    const alpha = pixels[i + 3]! / 255 * (overAlpha ? overAlpha[i + 3]! / 255 : 1)
    for (let c = 0; c < 4; c++) result[p + 4 + c] = result[p + c]! + (c === 3 ? alpha : pixels[i + c]! / 255 * alpha)
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
// Compose first: every pose and every source row uses exactly the same rigid
// translation interval, without row-dependent widths, centers or masks.
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
vec4 sweep(vec2 p){
  // A common positive translation kernel preserves the whole sprite's shape.
  // Its natural soft ends extend outside the center interval. Adjacent interval
  // integrals add to the union integral, so overlap is complementary, not a
  // second image or a gap. This averages distance, not physical shutter time.
  float n=max(span,1.);float x=p.x+(span-n)*.5;
  return (integral(x+n,p.y)-integral(x,p.y))/n;
}
void main(){
  vec2 q=vec2(gl_FragCoord.x,viewport.y-gl_FragCoord.y)-center;
  vec2 p=vec2(dot(q,axis),dot(q,vec2(-axis.y,axis.x)))+sprite*.5;
  color=clamp(sweep(p),0.,1.);
}`
