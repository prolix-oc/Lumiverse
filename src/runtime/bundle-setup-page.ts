// Normal literals let Bun's minifier escape Unicode without changing the HTML.
export const BUNDLE_SETUP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up Lumiverse</title><style>
:root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#111019;color:#eeeaf8}*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;padding:36px 20px;min-height:100vh;background:radial-gradient(ellipse at top,#28203d,transparent 65%)}
main{max-width:600px;margin:auto;background:#191621;border:1px solid #393047;border-radius:20px;padding:32px;box-shadow:0 24px 80px #0005}
.brand{color:#bca3f5;letter-spacing:.12em;font-size:12px;text-transform:uppercase}h1{font-size:30px;margin:24px 0 8px;line-height:1.2}
p{color:#b8afc9;margin:0 0 24px}label{display:block;font-weight:600;font-size:14px;margin:18px 0 6px}
input{width:100%;padding:12px;border:1px solid #51445f;border-radius:8px;background:#110f19;color:inherit;font:inherit}
input:focus,button:focus-visible{outline:2px solid #bca3f5;outline-offset:2px}small{display:block;color:#b8afc9;margin-top:6px;font-size:12px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}.check{display:flex;gap:10px;align-items:start;font-weight:400}.check input{width:auto;margin-top:5px}
fieldset{border:0;padding:0;margin:0;min-width:0}.steps{display:flex;gap:10px;list-style:none;padding:0;margin:24px 0;color:#92879f;font-size:13px}
.steps li{flex:1;padding-bottom:10px;border-bottom:2px solid #393047}.steps [aria-current=step]{color:#d8c5ff;border-color:#bca3f5}.steps span{margin-right:6px}
.actions{display:flex;gap:12px;margin-top:28px}button{padding:12px 18px;border:1px solid transparent;border-radius:9px;background:#c6adff;color:#211334;font:600 15px system-ui;cursor:pointer}
button.primary{flex:1}button.secondary{background:transparent;color:#d6c8ed;border-color:#51445f}button:disabled{opacity:.6;cursor:wait}
.folder{display:flex;gap:10px}.folder input{min-width:0}.folder button{flex-shrink:0}#message{margin-top:18px;white-space:pre-wrap}#message.error{color:#ffb4b4}
dl{margin:24px 0}dl div{padding:12px 0;border-bottom:1px solid #393047}dt{color:#b8afc9;font-size:13px}dd{margin:4px 0 0;overflow-wrap:anywhere}
@media(max-width:500px){body{padding:16px 12px}main{padding:24px}.row{grid-template-columns:1fr;gap:0}.steps{font-size:12px}.steps span{display:block}}
</style></head><body><main><div class="brand">Lumiverse &middot; First launch</div>
<ol class="steps" aria-label="Setup progress"><li aria-current="step"><span>1</span>Account</li><li><span>2</span>Server &amp; storage</li><li><span>3</span>Review</li></ol>
<h1 id="title">Make yourself at home.</h1><p id="description">Create your owner account to start Lumiverse.</p>
<form id="setup" novalidate>
<fieldset data-step="0"><label for="username">Username</label><input id="username" name="username" autocomplete="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9_.]+" value="admin" required>
<small>3&ndash;32 letters, numbers, underscores, or dots.</small><div class="row"><div><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></div><div>
<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></div></div></fieldset>
<fieldset data-step="1" hidden><label for="dataDir">Data folder</label><div class="folder"><input id="dataDir" name="dataDir" required spellcheck="false"><button id="browse" class="secondary" type="button" hidden>Browse…</button></div>
<small>Your chats, images, credentials, and encryption identity live here. Back up this folder.</small>
<label for="port">Server port</label><input id="port" name="port" type="number" min="1" max="65535" required>
<label class="check"><input id="lan" type="checkbox"><span>Allow connections from other devices on my network</span></label>
<small>Leave this off to accept connections only from this computer. Turning it on listens on all network interfaces.</small></fieldset>
<fieldset data-step="2" hidden><dl><div><dt>Owner account</dt><dd id="review-username"></dd></div><div><dt>Data folder</dt><dd id="review-dataDir"></dd></div>
<div><dt>Server port</dt><dd id="review-port"></dd></div><div><dt>Access</dt><dd id="review-access"></dd></div></dl><p>Use Back to change your choices. Your password will be saved as a hash.</p></fieldset>
<div class="actions"><button id="back" type="button" class="secondary" hidden>Back</button><button id="submit" type="submit" class="primary" disabled>Continue</button></div>
<div id="message" role="status" aria-live="polite"></div></form>
</main><script>
document.addEventListener('DOMContentLoaded',()=>{
  const field=name=>document.getElementById(name);
  const form=field('setup'),button=field('submit'),back=field('back'),message=field('message');
  const token=location.hash.slice(1)||sessionStorage.getItem('lumiverse.setup')||'';
  if(token)sessionStorage.setItem('lumiverse.setup',token);history.replaceState(null,'',location.pathname);
  const api=async(path,body)=>{
    const response=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Lumiverse-Setup':token},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'This setup link has expired. Use the link shown by Lumiverse.');return result;
  };
  const bridge=window.lumiverseSetupBridge||{defaults:()=>api('defaults'),save:body=>api('setup',body),status:()=>api('status'),complete:url=>location.replace(url)};
  let step=0,starting=false,loaded=false;
  const titles=['Make yourself at home.','Choose your server settings.','Ready to start?'];
  const descriptions=['Create your owner account to start Lumiverse.','Choose where Lumiverse keeps your data and who can connect.','Review your choices before saving them.'];
  function render(){
    document.querySelectorAll('[data-step]').forEach((panel,index)=>{panel.hidden=index!==step;});
    document.querySelectorAll('.steps li').forEach((item,index)=>{if(index===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');});
    field('title').textContent=titles[step];field('description').textContent=descriptions[step];
    back.hidden=step===0;back.disabled=starting;button.disabled=!loaded||starting;button.textContent=step===2?'Start Lumiverse':'Continue';
    field('review-username').textContent=field('username').value;field('review-dataDir').textContent=field('dataDir').value;
    field('review-port').textContent=field('port').value;field('review-access').textContent=field('lan').checked?'Other devices on my network':'Only this computer';
  }
  const showError=error=>{message.className='error';message.textContent=error instanceof Error?error.message:String(error);};
  async function poll(){
    try{const status=await bridge.status();
      if(status.state==='ready'){sessionStorage.removeItem('lumiverse.setup');message.className='';message.textContent='Lumiverse is ready. Opening your server…';await bridge.complete(status.url);return;}
      if(status.state==='failed'){showError(status.error);return;}
      if(status.state==='setup')return;
      starting=true;render();message.className='';message.textContent='Your account is saved. Starting Lumiverse…';
    }catch(error){showError(error);}
    setTimeout(poll,750);
  }
  bridge.defaults().then(settings=>{field('port').value=settings.port;field('dataDir').value=settings.dataDir;field('lan').checked=settings.host==='::';loaded=true;render();poll();}).catch(showError);
  if(bridge.pickFolder){field('browse').hidden=false;field('browse').addEventListener('click',async()=>{try{const selected=await bridge.pickFolder();if(selected)field('dataDir').value=selected;}catch(error){showError(error);}});}
  back.addEventListener('click',()=>{if(starting)return;step=Math.max(0,step-1);message.textContent='';render();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(starting||!loaded)return;message.className='';message.textContent='';
    const active=Array.from(document.querySelectorAll('[data-step="'+step+'"] input'));
    for(const input of active){if(!input.checkValidity()){input.reportValidity();return;}}
    if(step===0&&field('password').value!==field('confirm').value){showError(Error('The passwords do not match.'));return;}
    if(step<2){step++;render();return;}
    starting=true;render();
    try{await bridge.save({username:field('username').value,password:field('password').value,port:Number(field('port').value),dataDir:field('dataDir').value,host:field('lan').checked?'::':'127.0.0.1'});
      field('password').value='';field('confirm').value='';message.textContent='Your account is saved. Starting Lumiverse…';poll();
    }catch(error){starting=false;render();showError(error);}
  });
});
</script></body></html>`;
