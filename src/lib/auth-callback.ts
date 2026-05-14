// Brand-themed callback page served once at the localhost listener during
// desktop_code auth. Sent verbatim to the user's system browser. The visible
// message is the fallback for browsers (e.g. Safari) that refuse the
// scripted window.close().
export const AUTH_CALLBACK_HTML = `<!doctype html>
<meta charset="utf-8"><title>Signed in</title>
<style>
  :root { --dt-black:#231F20; --dt-pink:#DE5D83; --dt-muted:#6B6466; }
  html,body{margin:0;height:100%;}
  body{
    display:grid;place-items:center;background:#fff;color:var(--dt-black);
    font:16px/1.5 "Proxima Nova","Avenir Next","Inter",
      -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  }
  .card{text-align:center;max-width:360px;padding:32px;}
  .dot{width:14px;height:14px;border-radius:50%;background:var(--dt-pink);
    display:inline-block;margin-right:8px;vertical-align:middle;}
  h1{font-family:"Futura","Futura PT","Avenir Next",sans-serif;font-weight:600;
    font-size:22px;margin:0 0 8px;letter-spacing:-0.01em;}
  p{margin:0;color:var(--dt-muted);font-size:15px;}
</style>
<div class="card">
  <h1><span class="dot"></span>Signed in</h1>
  <p>You can close this tab and return to ex.</p>
</div>
<script>setTimeout(function(){try{window.close();}catch(_){}}, 200);</script>`;
