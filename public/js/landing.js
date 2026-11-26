import { hydrateIcons } from './icons.js';
import { bindThemeToggles, showVersion } from './common.js';

// Note links (/#/note/<id>) opened while signed out: go to sign-in and keep the note to open afterwards.
if (location.hash.startsWith('#/')) location.replace(`/login${location.hash}`);

hydrateIcons();
bindThemeToggles();

fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).then((c) => {
  document.title = c.appName;
  document.querySelectorAll('.app-name').forEach((n) => { n.textContent = c.appName; });
  showVersion(c);
  // Only advertise sign up when it is open.
  if (!c.allowSignup) document.querySelectorAll('.ld-signup').forEach((a) => a.remove());
  document.getElementById('ld-approval').classList.toggle('hidden', !c.allowSignup || !c.approvalRequired);
}).catch(() => {});
