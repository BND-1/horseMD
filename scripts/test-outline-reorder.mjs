import assert from 'node:assert/strict'
import { moveHeadingSection } from '../src/renderer/src/outline-reorder.js'

const source = `# Alpha

Alpha body

## Alpha child

Child body

# Bravo

Bravo body

## Bravo child

Bravo child body

# Charlie

Charlie body`

const bravoBeforeAlpha = moveHeadingSection(source, 2, 0, 'before')
assert.equal(bravoBeforeAlpha, `# Bravo

Bravo body

## Bravo child

Bravo child body

# Alpha

Alpha body

## Alpha child

Child body

# Charlie

Charlie body`)

const alphaAfterCharlie = moveHeadingSection(source, 0, 4, 'after')
assert.equal(alphaAfterCharlie, `# Bravo

Bravo body

## Bravo child

Bravo child body

# Charlie

Charlie body
# Alpha

Alpha body

## Alpha child

Child body

`)

assert.equal(moveHeadingSection(source, 1, 3, 'after'), null, 'moving a child into another parent must be rejected')

assert.equal(moveHeadingSection(source, 0, 1, 'before'), null, 'cross-level move must be rejected')
assert.equal(moveHeadingSection(source, 0, 0, 'before'), null, 'self move must be rejected')

console.log('PASS outline section reorder: sibling sections preserve descendants and raw Markdown')
