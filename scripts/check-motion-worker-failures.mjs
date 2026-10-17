import assert from 'node:assert/strict'

export async function checkMotionWorkerFailures(page, label) {
  const result = await page.evaluate(async () => {
    const { createDiscardCoverageRenderer } = await import('/src/discardMotion/coverage.ts')
    const source = window.motionSource, OriginalWorker = window.Worker
    const originalDecode = HTMLImageElement.prototype.decode
    const opacity = source.style.getPropertyValue('opacity'), priority = source.style.getPropertyPriority('opacity')
    const renderers = [], animations = [], urls = [], replies = []
    let probe, nonce = 0
    const until = async test => {
      const deadline = performance.now()+6000
      while (!test()) { if (performance.now()>deadline) throw Error('Worker failure/retirement check timed out: '+JSON.stringify([...document.querySelectorAll('.discard-motion-surface')].map(node=>({...node.dataset})))); await new Promise(resolve=>setTimeout(resolve,2)) }
    }
    const renderer = () => { const r=createDiscardCoverageRenderer();renderers.push(r);return r }
    const flight = r => {
      const movement=source.animate([{transform:'translate(0px,0px)'},{transform:'translate(280px,0px)'}],{duration:110,easing:'linear',fill:'forwards'})
      animations.push(movement)
      return {movement,handle:r.prepare({source,effects:[],movement,duration:110,easing:'linear',dx:280,dy:0})}
    }
    const restored = () => {
      if (source.style.opacity!=='0.8'||source.style.getPropertyPriority('opacity')!=='important') throw Error('Fallback lost the original opacity/priority')
    }
    try {
      source.style.setProperty('opacity','.8','important')
      window.Worker=class { constructor(){throw Error('Injected unsupported worker')} }
      const unsupported=renderer();unsupported.start()
      const sharp=flight(unsupported)
      if(sharp.handle||sharp.movement.playState!=='running'||document.querySelector('.discard-motion-surface')) throw Error('Unsupported renderer touched the native fallback')
      sharp.movement.cancel();unsupported.stop();restored()

      window.Worker=class extends OriginalWorker {
        postMessage(message,transfer) {
          if(message.type==='prepare'&&message.id>0) super.postMessage({...message,pixels:new Uint8ClampedArray(0)},[])
          else super.postMessage(message,transfer)
        }
      }
      const malformed=renderer();malformed.start();await until(()=>malformed.ready)
      const rejected=flight(malformed);await rejected.handle.finished
      if(!document.querySelector('.discard-motion-surface')?.dataset.failure?.includes('Invalid motion pixel atlas')) throw Error('Malformed input was not rejected explicitly')
      restored();rejected.movement.cancel();malformed.stop()

      window.Worker=class extends OriginalWorker {
        terminate() {
          super.terminate()
          setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:{type:'failed',id:0,reason:'Retired worker fatal reply'}})),10)
        }
      }
      const restarted=renderer();restarted.start();await until(()=>restarted.ready)
      restarted.stop();restarted.start();await until(()=>restarted.ready)
      await new Promise(resolve=>setTimeout(resolve,30))
      if(!restarted.ready||!document.querySelector('.discard-motion-surface')) throw Error('A retired worker stopped its replacement')
      restarted.stop();restored()

      // A busy main thread can deliver a ready message before the expired timer
      // task. A timer alone cannot enforce the preparation admission deadline.
      window.Worker=class extends OriginalWorker {
        set onmessage(listener) {
          super.onmessage=event=>{
            if(event.data.type==='ready'&&event.data.id>0) {
              const end=performance.now()+135;while(performance.now()<end){}
            }
            listener(event)
          }
        }
      }
      const delayedReady=renderer();delayedReady.start();await until(()=>delayedReady.ready)
      const late=flight(delayedReady);await late.handle.finished
      if(document.querySelector('.discard-flight-coverage')
        ||document.querySelector('.discard-motion-surface')?.dataset.failure!=='Preparation timeout'
        ||late.movement.playState!=='running')throw Error('Late ready message bypassed the elapsed admission deadline')
      restored();late.movement.cancel();delayedReady.stop()

      let prepares=0
      window.Worker=class extends OriginalWorker {
        postMessage(message,transfer) {
          if(message.type==='prepare'&&message.id>0)prepares++
          super.postMessage(message,transfer)
        }
      }
      const delayedDecode=renderer();delayedDecode.start();await until(()=>delayedDecode.ready)
      HTMLImageElement.prototype.decode=async function(...args) {
        await originalDecode.apply(this,args)
        const end=performance.now()+135;while(performance.now()<end){}
      }
      const decodedLate=flight(delayedDecode);await decodedLate.handle.finished
      HTMLImageElement.prototype.decode=originalDecode
      if(prepares!==0||document.querySelector('.discard-flight-coverage')
        ||document.querySelector('.discard-motion-surface')?.dataset.failure!=='Preparation timeout'
        ||decodedLate.movement.playState!=='running')throw Error('Late decoded snapshot still queued GPU preparation')
      restored();decodedLate.movement.cancel();delayedDecode.stop()

      window.Worker=class extends OriginalWorker {
        constructor(url,options) {
          const script=`
            let loaded=false,early=[],held=false,heldOnce=false;
            const counts={draws:0,createdTextures:0,deletedTextures:0,createdFences:0,deletedFences:0};
            const post=self.postMessage.bind(self);
            self.postMessage=(message,...transfer)=>post({...message,probeStats:{...counts}},...transfer);
            self.addEventListener('message',event=>{
              if(!loaded){early.push(event.data);return}
              if(event.data.type==='start'&&!heldOnce){held=heldOnce=true}
              if(event.data.type==='probe-release')held=false;
              if(event.data.type==='probe-stats')self.postMessage({type:'probe-stats',id:-1,nonce:event.data.nonce});
            });
            const get=OffscreenCanvas.prototype.getContext;
            OffscreenCanvas.prototype.getContext=function(kind,...args){
              const gl=get.call(this,kind,...args);if(kind!=='webgl2'||!gl)return gl;
              const wait=gl.clientWaitSync.bind(gl);gl.clientWaitSync=(...a)=>held?gl.TIMEOUT_EXPIRED:wait(...a);
              for(const [name,key]of [['drawArrays','draws'],['createTexture','createdTextures'],['deleteTexture','deletedTextures'],['fenceSync','createdFences'],['deleteSync','deletedFences']]){
                const original=gl[name].bind(gl);gl[name]=(...a)=>{counts[key]++;return original(...a)};
              }return gl;
            };
            await import(${JSON.stringify(new URL(String(url),document.baseURI).href)});
            loaded=true;for(const data of early)self.onmessage({data});early=[];
          `
          const wrapped=URL.createObjectURL(new Blob([script],{type:'text/javascript'}));urls.push(wrapped)
          super(wrapped,options);probe=this
          this.addEventListener('message',event=>replies.push(event.data))
        }
      }
      const stats=async()=>{
        const id=++nonce;probe.postMessage({type:'probe-stats',nonce:id})
        await until(()=>replies.some(reply=>reply.type==='probe-stats'&&reply.nonce===id))
        return replies.find(reply=>reply.type==='probe-stats'&&reply.nonce===id).probeStats
      }
      const held=renderer();held.start();await until(()=>held.ready)
      const first=flight(held);await until(()=>document.querySelector('.discard-flight-coverage'))
      const prepared=replies.findLast(reply=>reply.type==='ready').probeStats.draws
      let before
      do {before=await stats()} while(before.draws===prepared)
      first.handle.cancel();first.movement.cancel();await first.handle.finished;restored()
      const second=flight(held);await second.handle.finished
      const busy=replies.findLast(reply=>reply.type==='failed')
      if(!busy?.reason.includes('still retiring')||busy.probeStats.draws!==before.draws) throw Error('Cancellation queued another GPU draw before the old fence drained')
      second.movement.cancel();restored()
      probe.postMessage({type:'probe-release'})
      let drained
      do {drained=await stats();await new Promise(resolve=>setTimeout(resolve,2))} while(drained.deletedTextures!==drained.createdTextures)
      const third=flight(held);await third.handle.finished;third.movement.cancel();restored()
      const balanced=await stats()
      if(balanced.createdTextures!==balanced.deletedTextures||balanced.createdFences!==balanced.deletedFences) throw Error('Completed/drained draws leaked GPU resources')
      held.stop()

      const timeout=renderer();timeout.start();await until(()=>timeout.ready)
      const stuck=flight(timeout);await until(()=>document.querySelector('.discard-flight-coverage'))
      const initialDraws=replies.findLast(reply=>reply.type==='ready').probeStats.draws
      let submitted
      do {submitted=await stats()} while(submitted.draws===initialDraws)
      stuck.handle.cancel();stuck.movement.cancel();await stuck.handle.finished
      await until(()=>!timeout.ready&&!document.querySelector('.discard-motion-surface'))
      const fatal=replies.findLast(reply=>reply.type==='failed'&&reply.id===0)
      if(!fatal?.reason.includes('retirement')||fatal.probeStats.createdTextures!==fatal.probeStats.deletedTextures
        ||fatal.probeStats.createdFences!==fatal.probeStats.deletedFences) throw Error('A permanently stalled fence did not retire its context/resources')
      restored()
      return {unsupported:true,malformed:true,lateWorkerIgnored:true,lateReadyRejected:true,lateDecodeRejected:true,
        retiringRejected:true,retirementTimedOut:true,balanced}
    } finally {
      animations.forEach(animation=>animation.cancel());renderers.forEach(r=>r.stop())
      window.Worker=OriginalWorker;urls.forEach(url=>URL.revokeObjectURL(url))
      HTMLImageElement.prototype.decode=originalDecode
      if(opacity)source.style.setProperty('opacity',opacity,priority);else source.style.removeProperty('opacity')
    }
  })
  assert.equal(result.retiringRejected,true,`${label}: bounded GPU ownership`)
  return {label,failures:result}
}
