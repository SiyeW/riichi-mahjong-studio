const {app,BrowserWindow,Menu,powerMonitor,powerSaveBlocker}=require('electron')
const path=require('node:path')
// The marker documents current-task human authority; it does not grant it.
if(process.env.RMS_UI_FOREGROUND_AUTHORIZED!=='1')throw Error('Current-task foreground authorization is required')
if(!process.env.RMS_NATIVE_PROBE_DATA||!process.env.RMS_NATIVE_PROBE_URL)throw Error('Isolated native probe paths are required')
require('../electron/main/rendering-policy').configurePageRasterization(app)
app.setPath('userData',path.resolve(process.env.RMS_NATIVE_PROBE_DATA))
Menu.setApplicationMenu(null)
let blocker
app.on('will-quit',()=>{if(blocker!==undefined)powerSaveBlocker.stop(blocker)})
app.whenReady().then(()=>{
 if(!['active','idle'].includes(powerMonitor.getSystemIdleState(5)))throw Error('An unlocked OS session is required')
 const window=new BrowserWindow({show:false,width:1280,height:900,backgroundColor:'#02191e',webPreferences:{backgroundThrottling:false}})
 const events={invalidations:0,locks:0};global.nativeProbe={events}
 const invalidate=()=>events.invalidations++,lock=()=>{events.locks++;invalidate()}
 const listeners=[[window,'blur',invalidate],[window,'hide',invalidate],[window,'minimize',invalidate],[window,'move',invalidate],[window,'resize',invalidate],[powerMonitor,'lock-screen',lock],[powerMonitor,'suspend',invalidate]]
 listeners.forEach(([owner,event,callback])=>owner.on(event,callback))
 window.once('closed',()=>listeners.forEach(([owner,event,callback])=>owner.removeListener(event,callback)))
 blocker=powerSaveBlocker.start('prevent-display-sleep')
 window.maximize();window.show();window.focus()
 void window.loadURL(process.env.RMS_NATIVE_PROBE_URL)
})
app.on('window-all-closed',()=>app.quit())
