import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('../components/project-run-controls.tsx', import.meta.url), 'utf8'), {compilerOptions: {jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS}}).outputText;
const presentation = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/task-presentation.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, {
  exports:presentation, require:name => name === '@/utils/dashboardState' ? require('../utils/dashboardState.js') : require(name),
});
function render(status, planMode = 'openai') {
  let hook = 0;
  const exports = {};
  const mocks = {
    react: {...require('react'), useState: value => [hook++ === 0 ? status : value, () => {}], useEffect: () => {}, useCallback: fn => fn},
    'next/link': {default: 'a'},
    '@/components/ui/button': {Button: 'button'},
    '@/lib/data-store': {useData: () => ({system: {planMode}, tasks: []})},
    '@/lib/projects': {projectRequest: () => {}},
    '@/lib/task-presentation': presentation,
  };
  vm.runInNewContext(source, {exports, require: name => mocks[name] ?? require(name)});
  return renderToStaticMarkup(exports.ProjectRunControls({projectId: 'test'}));
}
test('search errors during retry never display OpenAI or key settings', () => {
  for (const state of ['running', 'waiting', 'stopping', 'stopped', 'failed']) {
    const html = render({state, errorType: 'SearchError', errorCode: 'search_overlay_blocked'});
    assert.doesNotMatch(html, /OpenAI|Код HTTP|Настройки ключа/);
    if (state === 'failed') assert.match(html, /Всплывающее окно мешает продолжению/);
  }
});
test('only OpenAI failures show key settings; HTTP labels require an HTTP code', () => {
  const http = render({state: 'failed', errorType: 'OpenAIPlanError', errorCode: 'http_401'});
  assert.match(http, /Настройки ключа/); assert.match(http, /Код HTTP: 401/);
  const timeout = render({state: 'failed', errorType: 'OpenAIPlanError', errorCode: 'timeout'});
  assert.doesNotMatch(timeout, /Код HTTP/); assert.match(timeout, /Код: timeout/);
  const generic = render({state: 'failed', errorType: 'Error', errorCode: 'execution_failed'});
  assert.match(generic, /Ошибка выполнения/); assert.doesNotMatch(generic, /OpenAI|Настройки ключа/);
});
