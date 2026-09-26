import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { observerBundle, routeBlock } from '../chatgpt/build-observer.mjs';
import { FIREFOX_EXTENSION_ID, FIREFOX_PRIVATE_EXTENSION_ID } from './profiles.mjs';

const shared = fileURLToPath(new URL('extension/', import.meta.url));
const chrome = fileURLToPath(new URL('../chatgpt/extension/', import.meta.url));
const firefox = fileURLToPath(new URL('../firefox/extension/', import.meta.url));
const scripts = ['service-worker.js', 'content-script.js', 'sidepanel.js', 'sidepanel-channel.js', 'sidepanel-model.js'];
export async function browserExtensionFiles(browser, { privateIdentity = false } = {}) {
  if (!['chrome', 'firefox'].includes(browser)) throw Error('UNSUPPORTED_BROWSER');
  const files = new Map(), isFirefox = browser === 'firefox';
  const routes = await routeBlock();
  for (const name of [...scripts, 'sidepanel.html', 'sidepanel.css']) {
    let content = await readFile(join(shared, name), 'utf8');
    content = content.replace(/\/\/ BEGIN GENERATED CONVERSATION ROUTES[\s\S]*?\/\/ END GENERATED CONVERSATION ROUTES/, () => routes);
    if (isFirefox) content = content.replace('const FIREFOX = false;', 'const FIREFOX = true;')
      .replaceAll('pap-chatgpt-chrome/9', 'pap-chatgpt-firefox/1').replaceAll('pap-chatgpt-capture/5', 'pap-firefox-chatgpt-capture/1')
      .replaceAll("'ai.provenance.consumer'", "'ai.provenance.consumer.firefox'").replaceAll('chrome.', 'browser.');
    files.set(name, content);
  }
  files.set('fetch-observer.js', await observerBundle());
  const manifest = JSON.parse(await readFile(join(shared, 'manifest.json'), 'utf8'));
  if (isFirefox) {
    delete manifest.key; delete manifest.minimum_chrome_version; delete manifest.side_panel;
    manifest.name = 'Attestamp for ChatGPT — Firefox';
    manifest.permissions = ['nativeMessaging', 'scripting'];
    manifest.background = { scripts: ['service-worker.js'] };
    manifest.sidebar_action = { default_panel: 'sidepanel.html', default_title: 'Attestamp' };
    manifest.browser_specific_settings = { gecko: { id: privateIdentity ? FIREFOX_PRIVATE_EXTENSION_ID : FIREFOX_EXTENSION_ID,
      strict_min_version: '153.0', data_collection_permissions: { required: ['websiteContent', 'personalCommunications', 'websiteActivity', 'browsingActivity'] } } };
  }
  files.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}
export async function buildBrowserExtensions({ check = false } = {}) {
  for (const [browser, directory] of [['chrome', chrome], ['firefox', firefox]]) {
    const files = await browserExtensionFiles(browser);
    if (!check) await mkdir(directory, { recursive: true });
    for (const [name, content] of files) {
      if (check) { if (await readFile(join(directory, name), 'utf8') !== content) throw Error(`STALE_${browser.toUpperCase()}_EXTENSION`); }
      else await writeFile(join(directory, name), content);
    }
    if (!check && browser === 'firefox') await cp(join(chrome, 'icons'), join(directory, 'icons'), { recursive: true });
  }
}
export async function writeBrowserExtension(directory, browser, options = {}) {
  await mkdir(directory, { mode: 0o700 });
  for (const [name, content] of await browserExtensionFiles(browser, options)) await writeFile(join(directory, name), content);
  await cp(join(chrome, 'icons'), join(directory, 'icons'), { recursive: true });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildBrowserExtensions({ check: process.argv.includes('--check') });
