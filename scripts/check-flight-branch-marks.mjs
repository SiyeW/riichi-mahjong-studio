import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function checkFlightBranchMarks(page, coverageTrial) {
  const evidence=process.env.RMS_UI_BRANCH_MARK_EVIDENCE
    ? path.resolve(import.meta.dirname,'../.mjai-runtime/branch-mark-flight') : null
  if(evidence)fs.mkdirSync(evidence,{recursive:true})
  await page.evaluate(()=>{
    const state=document.querySelector('#app').__vue_app__._instance.setupState
    window.branchMarkOriginal={view:structuredClone(JSON.parse(JSON.stringify(window.analysisCheck.vm.gameView))),
      jump:window.studioAPI.jumpToNode,animate:Element.prototype.animate,Worker:window.Worker,trial:state.coverageTrialEnabled}
    state.cancelPendingDiscardFlight();state.cancelPendingDiscardReturnFlight();state.coverageTrialEnabled=false
    window.branchMarkAnimations=[];window.branchMarkPrepares=[];window.branchMarkReplies=[]
    Element.prototype.animate=function(...args){const a=window.branchMarkOriginal.animate.apply(this,args);a.pause();a.currentTime=0;window.branchMarkAnimations.push(a);return a}
    window.branchMarkFixture=async({mark,drawn,riichi,id})=>{
      const {vm}=window.analysisCheck,actor=vm.status.controlledSeat,parent=structuredClone(window.branchMarkOriginal.view)
      const pai=drawn?'6s':'2s',root=`branch-mark-${id}`,childId=`${root}-discard`,otherId=`${root}-other`
      parent.currentNodeId=root;parent.table.pendingDiscard=null;parent.table.pendingRiichiDiscard=null
      parent.table.hands[actor]=['1m','2m','3m','4m','5m','6m','7m','8m','9m','1s','2s','3s','4s','6s']
      parent.table.rivers[actor]=[];parent.table.actionHistory=[{type:'tsumo',actor,pai:'6s'}]
      parent.tree={rootNodeId:root,currentNodeId:root,currentRoundRootId:root,mainLeafNodeId:childId,revision:1,rounds:[],nodes:[
        {id:root,parentId:null,children:mark==='side'?[childId,otherId]:[childId],mainChildId:mark==='side'?otherId:childId,depth:0},
        {id:childId,parentId:root,children:[],depth:1,action:mark==='none'?undefined:{type:'dahai',actor,pai,tsumogiri:drawn}},
        ...(mark==='side'?[{id:otherId,parentId:root,children:[],depth:1,action:{type:'dahai',actor,pai:'3s',tsumogiri:false}}]:[])]}
      const child=structuredClone(parent);child.currentNodeId=childId
      child.table.hands[actor].splice(drawn?13:10,1)
      child.table.pendingDiscard={actor,pai,tsumogiri:drawn,targetActor:actor,riichi}
      child.table.actionHistory.push({type:'dahai',actor,pai,tsumogiri:drawn})
      window.studioAPI.jumpToNode=async node=>({state:JSON.parse(JSON.stringify(vm.status)),view:structuredClone(node===childId?child:parent)})
      await vm.jumpToNode(root);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
      window.branchMarkCase={parent,child,actor,pai,mark,drawn,riichi}
      const selector=mark==='none'?`[data-hand-seat="${actor}"]${drawn?'.is-drawn':''} .tileImg[src$="/${pai}.svg"]`
        :`[data-hand-seat="${actor}"] .tile-next-${mark}`
      const image=document.querySelector(selector)
      if(!image)throw Error('Branch fixture did not display its actual hand tile: '+selector)
      return{shadow:getComputedStyle(image).boxShadow,hint:mark==='none'?'':`tile-next-${mark}`}
    }
  })
  const results=[]
  const jump=async reverse=>{
    await page.evaluate(async reverse=>{
      window.branchMarkAnimations=[]
      const c=window.branchMarkCase
      await window.analysisCheck.vm.jumpToNode(reverse?c.parent.currentNodeId:c.child.currentNodeId)
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    },reverse)
  }
  try{
    let id=0
    for(const mark of ['main','side','none'])for(const drawn of [false,true])for(const riichi of [false,true]){
      const initial=await page.evaluate(options=>window.branchMarkFixture(options),{mark,drawn,riichi,id:++id})
      for(const reverse of [false,true]){
        await jump(reverse)
        const checkpoints=[]
        for(const time of [0,40,90,110]){
          const item=await page.evaluate(({time,reverse})=>{
            window.branchMarkAnimations.forEach(a=>{a.currentTime=time})
            const c=window.branchMarkCase,root=reverse?document.querySelector('.discard-return-ghost'):document.querySelector(`[data-pending-discard-seat="${c.actor}"]`)
            const pose=root?.querySelector('.discard-flight-regular-pose'),image=pose?.querySelector('.tileImg'),settled=root?.querySelector('.tileImg')
            if(!root)throw Error('Missing real branch flight')
            return{hint:image?.classList.contains('tile-next-main')?'tile-next-main':image?.classList.contains('tile-next-side')?'tile-next-side':'',
              opacity:pose?Number(getComputedStyle(pose).opacity):null,shadow:image?getComputedStyle(image).boxShadow:null,
              baseOpacity:Number(getComputedStyle(settled).opacity),effects:window.branchMarkAnimations.filter(a=>a.effect.getKeyframes().some(k=>k.opacity!==undefined)).length}
          },{time,reverse})
          checkpoints.push(item)
          assert.equal(item.hint,initial.hint,`carried branch ${JSON.stringify({mark,drawn,riichi,reverse,time,item})}`)
          if(mark!=='none'){
            assert.equal(item.shadow,initial.shadow,'reuse the actual hand branch style at both endpoints')
            assert.equal(item.effects,riichi?2:1,'reuse bounded pose/overlay effects')
            const fade=Math.max(0,Math.min(1,(time/110-.2)/.55))
            assert.ok(Math.abs(item.opacity-(reverse?fade:1-fade))<.001)
            if(!riichi)assert.equal(item.baseOpacity,1,'ordinary marked tiles must not dim during the red-frame handoff')
          }
          if(evidence&&mark==='main'&&!drawn&&!riichi){
            const target=page.locator(reverse?'.discard-return-ghost':`[data-pending-discard-seat="${await page.evaluate(()=>window.branchMarkCase.actor)}"]`)
            await target.screenshot({path:path.join(evidence,`${reverse?'return':'discard'}-${time}.png`),animations:'allow'})
          }
        }
        await page.evaluate(async reverse=>{
          const c=window.branchMarkCase,root=reverse?document.querySelector('.discard-return-ghost'):document.querySelector(`[data-pending-discard-seat="${c.actor}"]`)
          const move=window.branchMarkAnimations.find(a=>a.effect.target===root);move.finish()
          for(let i=0;i<4;i++)await new Promise(resolve=>requestAnimationFrame(resolve))
          if(document.querySelector('.discard-return-ghost,.discard-flight-regular-pose'))throw Error('Branch overlay survived landing')
          if([...document.querySelectorAll('[data-hand-seat]')].some(node=>node.style.visibility==='hidden'))throw Error('Branch return left its destination hidden')
          if(document.querySelector('.grid-discard .tile-next-main,.grid-discard .tile-next-side'))throw Error('Branch mark leaked onto the settled river')
        },reverse)
        results.push({mark,drawn,riichi,reverse,checkpoints})
      }
      if(mark==='main'&&!drawn){
        await jump(false);await jump(true);await jump(false)
        await page.evaluate(()=>{
          const state=document.querySelector('#app').__vue_app__._instance.setupState
          state.cancelPendingDiscardFlight();state.cancelPendingDiscardReturnFlight()
          if(document.querySelector('.discard-return-ghost,.discard-flight-regular-pose'))throw Error('Superseded branch overlay survived cancellation')
        })
      }
    }
    if(coverageTrial){
      await page.evaluate(async()=>{
        Element.prototype.animate=window.branchMarkOriginal.animate
        window.Worker=class extends window.branchMarkOriginal.Worker{
          constructor(...args){super(...args);const replies=window.branchMarkReplies;this.addEventListener('message',event=>replies.push(event.data))}
          postMessage(message,transfer){
            if(message.type==='prepare'&&message.id>0){
              const {pixels,geometry:g}=message,planeBytes=g.spriteWidth*g.spriteHeight*4,red=[]
              for(let plane=0;plane<message.planeCount;plane++){let count=0;for(let i=plane*planeBytes;i<(plane+1)*planeBytes;i+=4)if(pixels[i]>110&&pixels[i]>pixels[i+1]*1.4&&pixels[i]>pixels[i+2]*1.4&&pixels[i+3]>128)count++;red.push(count)}
              window.branchMarkPrepares.push({id:message.id,mode:message.mode,planes:message.planeCount,effects:message.stops.length,red})
            }super.postMessage(message,transfer)
          }
        }
        document.querySelector('#app').__vue_app__._instance.setupState.coverageTrialEnabled=true
      })
      await page.locator('.discard-motion-surface[data-ready="true"]').waitFor({state:'attached'})
      for(const mark of ['main','side'])for(const drawn of [false,true])for(const riichi of [false,true]){
        await page.evaluate(options=>window.branchMarkFixture(options),{mark,drawn,riichi,id:++id})
        for(const reverse of [false,true]){
          await page.evaluate(()=>{window.branchMarkPrepares=[]})
          await jump(reverse)
          await page.waitForFunction(()=>window.branchMarkPrepares.length>0)
          const prepare=await page.evaluate(()=>window.branchMarkPrepares[0])
          assert.equal(prepare.mode,riichi?'crossfade':'overlay')
          assert.equal(prepare.planes,2);assert.equal(prepare.effects,riichi?2:1)
          assert.equal(prepare.red[0],0,'settled river snapshot stays unmarked')
          assert.ok(prepare.red[1]>10,`real worker snapshot contains branch pixels ${JSON.stringify({mark,drawn,riichi,reverse,prepare})}`)
          await page.waitForFunction(()=>!document.querySelector('#app').__vue_app__._instance.setupState.tableMotionActive)
          const playback=await page.evaluate(id=>window.branchMarkReplies.find(reply=>reply.type==='done'&&reply.id===id),prepare.id)
          assert.ok(playback?.intervals?.some(interval=>interval.span>0),`marked flight must actually render in the worker, not silently fall back: ${JSON.stringify({mark,drawn,riichi,reverse,prepare,playback})}`)
        }
      }
    }
  }finally{
    await page.evaluate(async()=>{
      const original=window.branchMarkOriginal,state=document.querySelector('#app').__vue_app__._instance.setupState
      state.cancelPendingDiscardFlight();state.cancelPendingDiscardReturnFlight();state.coverageTrialEnabled=false
      Element.prototype.animate=original.animate;window.Worker=original.Worker
      window.studioAPI.jumpToNode=async()=>({state:JSON.parse(JSON.stringify(window.analysisCheck.vm.status)),view:original.view})
      await window.analysisCheck.vm.jumpToNode(original.view.currentNodeId)
      window.studioAPI.jumpToNode=original.jump;state.coverageTrialEnabled=original.trial
      delete window.branchMarkOriginal;delete window.branchMarkAnimations;delete window.branchMarkPrepares;delete window.branchMarkReplies;delete window.branchMarkFixture;delete window.branchMarkCase
    })
  }
  console.log(`Branch-mark flights: ${results.length} native trajectories, marked worker snapshots ${coverageTrial?'verified':'not requested'}.`)
}
