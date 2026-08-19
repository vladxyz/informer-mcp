/**
 * The HTML served by the setup server. Kept in its own module so the server
 * logic stays readable; no external assets, because the page must work offline.
 */

export function setupPage(token: string, configPath: string, existing: SetupRow[], savedHint: string): string {
  const state = JSON.stringify({ token, configPath, existing, savedHint }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Informer MCP setup</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #fff; --ink: #16181d; --muted: #6b7280;
    --line: #dfe3e8; --accent: #4f46e5; --ok: #047857; --bad: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --card:#1c1f25; --ink:#e8eaed; --muted:#9aa0aa;
            --line:#2c313a; --accent:#818cf8; --ok:#34d399; --bad:#f87171; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem 4rem; background:var(--bg); color:var(--ink);
         font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .35rem; }
  p.lede { color:var(--muted); margin:0 0 1.75rem; }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em;
         background:color-mix(in srgb, var(--ink) 8%, transparent); padding:.1em .35em; border-radius:4px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
          padding:1.1rem 1.15rem; margin-bottom:1rem; }
  .row-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:.9rem; }
  .row-head strong { font-size:1rem; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:.85rem; }
  label { display:block; font-size:.8rem; font-weight:600; color:var(--muted);
          text-transform:uppercase; letter-spacing:.04em; margin-bottom:.3rem; }
  input, select { width:100%; padding:.5rem .6rem; border:1px solid var(--line); border-radius:6px;
                  background:var(--bg); color:var(--ink); font:inherit; }
  input:focus, select:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  .hint { font-size:.8rem; color:var(--muted); margin-top:.3rem; }
  button { font:inherit; padding:.5rem .9rem; border-radius:6px; border:1px solid var(--line);
           background:var(--card); color:var(--ink); cursor:pointer; }
  button.primary { background:var(--accent); border-color:transparent; color:#fff; font-weight:600; }
  button.link { border:0; background:none; color:var(--muted); padding:.25rem; text-decoration:underline; }
  button:disabled { opacity:.55; cursor:default; }
  .actions { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; margin-top:1.25rem; }
  .status { margin-top:1rem; white-space:pre-wrap; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  ul.results { list-style:none; padding:0; margin:.75rem 0 0; }
  ul.results li { padding:.4rem 0; border-top:1px solid var(--line); }
  .check { display:flex; align-items:center; gap:.5rem; font-size:.9rem; color:var(--muted); }
  .check input { width:auto; }
</style>
</head>
<body>
<main>
  <h1>Informer MCP setup</h1>
  <p class="lede">
    Enter the API key and security code of every administration you want to reach.
    Both are created inside the administration itself:
    <a href="https://app.informer.eu/settings/api/" target="_blank" rel="noreferrer">API key</a> ·
    <a href="https://app.informer.eu/settings/account/" target="_blank" rel="noreferrer">security code</a>.
    They are written to <code id="path"></code> and never leave this machine.
  </p>

  <div id="rows"></div>

  <div class="actions">
    <button type="button" id="add">Add administration</button>
    <button type="button" class="primary" id="save">Verify &amp; save</button>
    <label class="check"><input type="checkbox" id="skip" /> Save without verifying</label>
  </div>

  <div class="status" id="status"></div>
</main>

<script>
const STATE = ${state};
document.getElementById('path').textContent = STATE.configPath;

const rows = document.getElementById('rows');
const status = document.getElementById('status');

function addRow(data = {}) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = \`
    <div class="row-head">
      <strong>Administration</strong>
      <button type="button" class="link remove">Remove</button>
    </div>
    <div class="grid">
      <div>
        <label>Alias</label>
        <input class="alias" placeholder="acme" />
        <div class="hint">Short handle you use in prompts. Letters, digits, - and _.</div>
      </div>
      <div>
        <label>Company name</label>
        <input class="label" placeholder="ACME BV" />
        <div class="hint">Optional, shown in tool descriptions.</div>
      </div>
      <div>
        <label>API key</label>
        <input class="apiKey" type="password" autocomplete="off" spellcheck="false" />
      </div>
      <div>
        <label>Security code</label>
        <input class="securityCode" type="password" autocomplete="off" spellcheck="false" />
      </div>
      <div>
        <label>Access</label>
        <select class="mode">
          <option value="read-write">Read and write</option>
          <option value="read-only">Read only</option>
        </select>
        <div class="hint">Read only hides every tool that changes this client's books.</div>
      </div>
    </div>\`;

  card.querySelector('.alias').value = data.alias || '';
  card.querySelector('.label').value = data.label || '';
  card.querySelector('.mode').value = data.mode || 'read-write';
  if (data.hasCredentials) {
    for (const field of ['apiKey', 'securityCode']) {
      const input = card.querySelector('.' + field);
      input.placeholder = 'unchanged — leave blank to keep';
      input.dataset.keep = 'true';
    }
  }
  card.querySelector('.remove').addEventListener('click', () => {
    card.remove();
    if (!rows.children.length) addRow();
  });
  rows.append(card);
}

function collect() {
  return [...rows.children].map((card) => {
    const value = (selector) => card.querySelector(selector).value.trim();
    const entry = {
      alias: value('.alias'),
      label: value('.label'),
      apiKey: value('.apiKey'),
      securityCode: value('.securityCode'),
      mode: value('.mode'),
    };
    entry.keepExisting = card.querySelector('.apiKey').dataset.keep === 'true' && !entry.apiKey && !entry.securityCode;
    return entry;
  });
}

document.getElementById('add').addEventListener('click', () => addRow());

document.getElementById('save').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  status.className = 'status';
  status.textContent = 'Verifying…';

  try {
    const response = await fetch('/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-informer-token': STATE.token },
      body: JSON.stringify({ administrations: collect(), verify: !document.getElementById('skip').checked }),
    });
    const body = await response.json();

    if (!body.ok) {
      status.className = 'status bad';
      status.textContent = body.error || 'Something went wrong.';
    } else {
      status.className = 'status ok';
      status.innerHTML = 'Saved to <code>' + body.path + '</code>. ' + STATE.savedHint;
    }

    if (body.results && body.results.length) {
      const list = document.createElement('ul');
      list.className = 'results';
      for (const result of body.results) {
        const item = document.createElement('li');
        item.className = result.ok ? 'ok' : 'bad';
        item.textContent = result.ok
          ? result.alias + ' → ' + (result.company_name || 'verified')
          : result.alias + ' → ' + result.error;
        list.append(item);
      }
      status.append(list);
    }
  } catch (error) {
    status.className = 'status bad';
    status.textContent = String(error);
  } finally {
    button.disabled = false;
  }
});

if (STATE.existing.length) STATE.existing.forEach(addRow);
else addRow();
</script>
</body>
</html>`;
}

/** One administration as shown in the form. Credentials are never sent to the page. */
export interface SetupRow {
  alias: string;
  label?: string;
  mode: 'read-only' | 'read-write';
  hasCredentials: boolean;
}
