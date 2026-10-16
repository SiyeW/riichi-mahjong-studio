/** Premultiplied row integrals; sampling cost never grows with trail length. */
export function rowIntegrals(pixels: Uint8ClampedArray, width: number, height: number,
  overAlpha?: Uint8ClampedArray): Float32Array {
  if (pixels.length !== width * height * 4 || (overAlpha && overAlpha.length !== pixels.length)) throw Error('Invalid motion plane')
  const result = new Float32Array((width + 1) * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, p = (y * (width + 1) + x) * 4
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
vec4 line(sampler2D s,float x,int y){
  if(y<0||y>=int(sprite.y))return vec4(0.);
  float p=clamp(x,0.,sprite.x);int a=int(floor(p));int b=min(a+1,int(sprite.x));
  return mix(texelFetch(s,ivec2(a,y),0),texelFetch(s,ivec2(b,y),0),fract(p));
}
vec4 integral(sampler2D s,float x,float y){float r=y-.5;int a=int(floor(r));return mix(line(s,x,a),line(s,x,a+1),fract(r));}
vec4 sweep(sampler2D s,vec2 p){
  float n=max(span,1.);float x=p.x+(span-n)*.5;
  return (integral(s,x+n,p.y)-integral(s,x,p.y))/n;
}
void main(){
  vec2 q=vec2(gl_FragCoord.x,viewport.y-gl_FragCoord.y)-center;
  vec2 p=vec2(dot(q,axis),dot(q,vec2(-axis.y,axis.x)))+sprite*.5;
  color=weights.x*sweep(planeA,p);
  if(weights.y>0.)color+=weights.y*sweep(planeB,p);
  if(weights.z>0.)color-=weights.z*sweep(product,p);
  color=clamp(color,0.,1.);
}`
