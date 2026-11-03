import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hashPassword, verifyPassword, token, sha256} from '../src/security.js';
test('passwords are salted and verified; tokens are unpredictable and hashed',async()=>{
 const a=await hashPassword('a very long password'), b=await hashPassword('a very long password');
 assert.notEqual(a,b); assert.equal(await verifyPassword('a very long password',a),true); assert.equal(await verifyPassword('wrong password',a),false); assert.equal(await verifyPassword('wrong','invalid'),false);
 const t=token(); assert.notEqual(t,token()); assert.notEqual(t,sha256(t));
});
