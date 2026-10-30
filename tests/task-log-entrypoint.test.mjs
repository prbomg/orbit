import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { poolFixture } from './helpers/pool-fixture.mjs';
import store from '../utils/taskLogStore.js';
import downloads from '../utils/taskLogDownloads.js';
const exec = promisify(execFile);

test('actual worker entrypoint persists exact attempt metadata and flushes before exit', { timeout: 30000 }, async () => {
  const f = await poolFixture();
  try {
    const task = await f.task(), profile = await f.ready(), startedAt = new Date();
    const execution = await f.db.taskExecution.create({ data: { taskId: task.id, profileId: profile.id, status: 'completed', attempts: 2, startedAt, completedAt: startedAt } });
    // Only replace the browser runner and environment config. Exercise the real
    // entrypoint, Prisma metadata lookup, logger, shutdown flush and download reader.
    const runner = `export async function pollDatabase({log}) {
      const details={taskId:process.env.TEST_TASK_ID,executionId:process.env.TEST_EXECUTION_ID};
      log('execution_allocated',details);log('test_observation',{...details,password:'DO_NOT_LOG'});
      log('session_completed',details);return 0;
    }`;
    const config = `export const projectRoot = process.cwd() + '/'; export function loadConfig(){return {databasePath:process.env.TEST_DATABASE_PATH,databaseUrl:'file:'+process.env.TEST_DATABASE_PATH,profilesDirectory:process.env.TEST_PROFILES_PATH};}`;
    const loader = join(f.dir, 'loader.mjs');
    await writeFile(loader, `export async function load(url,context,next){
      if(url.endsWith('/worker/runner.mjs'))return {format:'module',shortCircuit:true,source:${JSON.stringify(runner)}};
      if(url.endsWith('/worker/config.mjs'))return {format:'module',shortCircuit:true,source:${JSON.stringify(config)}};
      return next(url,context);
    }`);
    const { stdout } = await exec(process.execPath, ['--experimental-loader', loader, resolve('worker/index.js'), '--once'], {
      cwd: f.dir, timeout: 20000, env: { ...process.env, DATABASE_URL: `file:${f.dir}/test.db`, ORBIT_WORKER_RUN_ID: '',
        TEST_DATABASE_PATH: join(f.dir, 'test.db'), TEST_PROFILES_PATH: join(f.dir, 'profiles'), TEST_TASK_ID: task.id, TEST_EXECUTION_ID: execution.id },
    });
    assert.match(stdout, /"technicalLogFormat":2/);
    const root = join(f.dir, 'logs/tasks'), catalog = await store.readCatalog(root);
    assert.equal(catalog.attempts.length, 1);
    const a = catalog.attempts[0];
    assert.equal(a.executionId, execution.id); assert.equal(a.executionStartedAt, startedAt.toISOString());
    assert.equal(a.attempt, 2); assert.equal(a.status, 'success'); assert.equal(a.events, 3);
    assert.equal((await readdir(root)).some(name => /^task-.*\.txt$/.test(name)), false);
    const index = await downloads.response(new Request('http://localhost/?' + new URLSearchParams({format:'index', executionId:execution.id, startedAt:startedAt.toISOString()})), task.id, root);
    assert.equal((await index.json()).attempts[0].id, a.id);
    const response = await downloads.response(new Request(`http://localhost/?attemptId=${a.id}`), task.id, root);
    assert.equal(response.status, 200); const text = await response.text();
    assert.match(text, /test_observation/); assert.ok(!text.includes('DO_NOT_LOG'));
  } finally { await f.cleanup(); }
});
