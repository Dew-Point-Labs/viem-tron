import { expect, it } from 'vitest'
import { tronWebTransport } from '../src/index.js'

it('exports tronWebTransport, which is not implemented yet', () => {
  expect(tronWebTransport).toBeTypeOf('function')
  expect(() => tronWebTransport()).toThrow('not implemented')
})
