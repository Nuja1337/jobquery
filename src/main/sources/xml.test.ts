import { describe, expect, it } from 'vitest'
import { xmlBlocks, xmlText, xmlTexts } from './xml'

describe('xml reader', () => {
  const xml = `<?xml version="1.0"?>
<root>
  <item><name>One &amp; Two</name><body><![CDATA[<p>Hello &amp; bye</p>]]></body><empty/></item>
  <item a="1"><name>Three</name><items><sub>x</sub><sub>y</sub></items></item>
  <itemized>not an item</itemized>
</root>`

  it('finds blocks by exact tag name', () => {
    expect(xmlBlocks(xml, 'item')).toHaveLength(2)
    expect(xmlBlocks(xml, 'itemized')).toHaveLength(1)
  })

  it('decodes entities and reads CDATA as it is', () => {
    const [first] = xmlBlocks(xml, 'item')
    expect(xmlText(first, 'name')).toBe('One & Two')
    expect(xmlText(first, 'body')).toBe('<p>Hello &amp; bye</p>')
    expect(xmlText(first, 'empty')).toBeNull()
    expect(xmlText(first, 'missing')).toBeNull()
  })

  it('lists repeated tags', () => {
    expect(xmlTexts(xml, 'sub')).toEqual(['x', 'y'])
  })

  it('reads text before and after CDATA in one value', () => {
    expect(xmlText('<a>x &lt; <![CDATA[<b>]]> y</a>', 'a')).toBe('x < <b> y')
  })
})
