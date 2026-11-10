import assert from 'node:assert/strict'
import test from 'node:test'
import { refOf } from '../server/lib/paperclip.mjs'

const projects = new Map([['b', 'Baltis and Ballotta'], ['n', 'Night Rules'], ['s', 'nGen Studio'], ['a', 'Aldis']])

test('a job is read by its project code with Paperclip\'s number', () => {
  assert.equal(refOf({ identifier: 'NGE-313', projectId: 's', title: 'The app cannot reach the studio' }, projects), 'STU-313')
  assert.equal(refOf({ identifier: 'NGE-307', projectId: 'n', title: 'Phase 1b' }, projects), 'NR-307')
  assert.equal(refOf({ identifier: 'NGE-322', projectId: 'a', title: 'M9 critic read' }, projects), 'ALD-322')
  assert.equal(refOf({ identifier: 'NGE-304', projectId: 'b', title: 'Baltis map' }, projects), 'BAL-304')
  assert.equal(refOf({ identifier: 'NGE-305', projectId: 'b', title: 'Ballotta scorecard' }, projects), 'BLT-305')
  assert.equal(refOf({ identifier: 'NGE-30', title: 'Continue with what is left' }, projects), 'CREW-30')
  assert.equal(refOf({ title: 'no number yet' }, projects), '')
})
