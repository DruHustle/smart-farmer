import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('both required language options exist',async()=>{const source=await readFile(new URL('../src/main.tsx',import.meta.url),'utf8');assert.match(source,/value="sn"/);assert.match(source,/value="nd"/);assert.doesNotMatch(source,/value="nr"/);});
