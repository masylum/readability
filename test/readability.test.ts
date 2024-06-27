import {
    load,
    type AnyNode,
    type Cheerio,
    type CheerioAPI,
    type Element,
} from 'cheerio'
import { expect, describe, it, beforeAll } from 'vitest'
import { Readability, type ReadabilityResult } from '../src/index.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import beautify from 'js-beautify'

const testPageRoot = fileURLToPath(new URL('./test-pages', import.meta.url))
const testPages = readdirSync(testPageRoot)

function readFile(filePath: string) {
    return readFileSync(filePath, { encoding: 'utf-8' }).trim()
}

function readJSON(jsonPath: string) {
    return JSON.parse(readFile(jsonPath))
}

function getTestPagesData(dir: string) {
    console.log('testing', dir)
    return {
        dir: dir,
        source: readFile(join(testPageRoot, dir, 'source.html')),
        expectedContent: readFile(join(testPageRoot, dir, 'expected.html')),
        expectedMetadata: readJSON(
            join(testPageRoot, dir, 'expected-metadata.json')
        ),
    }
}
function nodeStr(n: AnyNode | null) {
    if (!n) return '(no node)'
    if (n.type == 'text') return `#text(${htmlTransform(n.data)})`
    if (n.type !== 'tag') return `#${n.nodeType}`

    let rv = n.tagName
    if (n.attribs?.id) rv += `#${n.attribs?.id}`
    if (n.attribs?.className) rv += `.(${n.attribs?.className})`

    return rv
}

function genPath(node: AnyNode): string {
    if (!node) return '(no node)'
    if (node.type !== 'tag') return '(no tag)'
    if (node.attribs?.id) return `#${node.attribs?.id}`
    if (node.tagName == 'body') return '(body)'

    const parent = node.parentNode
    if (!parent) return '(no parent)'

    const parentPath = genPath(parent)
    const index = parent.childNodes.indexOf(node) + 1

    return `${parentPath} > ${nodeStr(node)}:nth-child(${index})`
}

function findableNodeDesc(node: AnyNode) {
    const parent = node.parentNode
    const parentTag = parent?.type === 'tag' ? parent.tagName : 'no parent'

    return `${genPath(node)} (in: "${parentTag}")`
}

function attributesForNode(node: Element) {
    return node.attributes.map((attr) => `${attr.name}=${attr.value}`).join(',')
}

function prettyPrint(html: string | null) {
    if (!html) return null

    return beautify.html(html, {
        indent_size: 4,
        indent_char: ' ',
        indent_level: 0,
        indent_with_tabs: false,
        preserve_newlines: false,
        wrap_line_length: 0,
        wrap_attributes: 'auto',
        wrap_attributes_indent_size: 4,
    })
}

function inOrderTraverse(fromNode: AnyNode) {
    if (fromNode.type === 'tag' && fromNode.firstChild) {
        return fromNode.firstChild
    }
    let nextNode: AnyNode | null = fromNode
    while (nextNode && !nextNode.nextSibling) {
        nextNode = nextNode.parentNode
    }
    return nextNode ? nextNode.nextSibling : null
}

function inOrderIgnoreEmptyTextNodes(node: AnyNode | null) {
    let nextNode: AnyNode | null = node

    while (nextNode) {
        nextNode = inOrderTraverse(nextNode)
        if (nextNode && nextNode.type === 'text' && nextNode.data.trim()) {
            break
        }
    }
    return nextNode
}

function traverseDOM(
    callback: (el1: AnyNode | null, el2: AnyNode | null) => boolean,
    $expected: Cheerio<AnyNode>,
    $actual: Cheerio<AnyNode>
) {
    let actualNode = $actual.contents()[0] || null
    let expectedNode = $expected.contents()[0] || null

    while (actualNode || expectedNode) {
        // We'll stop if we don't have both actualNode and expectedNode
        if (!callback(actualNode, expectedNode)) {
            break
        }
        actualNode = inOrderIgnoreEmptyTextNodes(actualNode)
        expectedNode = inOrderIgnoreEmptyTextNodes(expectedNode)
    }
}

// Collapse subsequent whitespace like HTML:
function htmlTransform(str: string | null) {
    if (!str) return str
    return str.replace(/\s+/g, ' ')
}

function runTestsWithItems(
    label: string,
    domGenerationFn: (source: string | null) => CheerioAPI,
    source: string,
    expectedContent: string,
    expectedMetadata: Record<string, any>
) {
    describe(label, () => {
        let result: ReadabilityResult
        let $: CheerioAPI

        beforeAll(() => {
            $ = domGenerationFn(source)
            // Provide one class name to preserve, which we know appears in a few
            // of the test documents.
            const reader = new Readability($, {
                classesToPreserve: ['caption'],
                // debug: true,
            })
            result = reader.parse()
        })

        it('should extract expected content', () => {
            const $actual = domGenerationFn(prettyPrint(result.content)).root()
            const $expected = domGenerationFn(
                prettyPrint(expectedContent)
            ).root()

            traverseDOM(
                (actualNode, expectedNode) => {
                    if (actualNode && expectedNode) {
                        const actualDesc = nodeStr(actualNode)
                        const expectedDesc = nodeStr(expectedNode)

                        if (actualDesc !== expectedDesc) {
                            expect(
                                actualDesc,
                                findableNodeDesc(actualNode)
                            ).eql(expectedDesc)
                            return false
                        }

                        // Compare text for text nodes:
                        if (
                            actualNode.type === 'text' &&
                            expectedNode.type === 'text'
                        ) {
                            const actualText = htmlTransform(actualNode.data)
                            const expectedText = htmlTransform(
                                expectedNode.data
                            )

                            expect(
                                actualText,
                                findableNodeDesc(actualNode)
                            ).eql(expectedText)

                            if (actualText !== expectedText) return false

                            // Compare attributes for element nodes:
                        } else if (
                            actualNode.type === 'tag' &&
                            expectedNode.type === 'tag'
                        ) {
                            const actualNodeDesc = attributesForNode(actualNode)
                            const expectedNodeDesc =
                                attributesForNode(expectedNode)
                            const nodeDesc = nodeStr(actualNode)

                            expect(
                                actualNode.attributes.length,
                                `node ${nodeDesc} attributes (${actualNodeDesc}) should match (${expectedNodeDesc})`
                            ).eql(expectedNode.attributes.length)

                            actualNode.attributes.forEach((attr) => {
                                const expectedValue =
                                    expectedNode.attribs[attr.name]
                                const nodeDesc = findableNodeDesc(actualNode)

                                expect(
                                    expectedValue,
                                    `node (${nodeDesc}) attribute ${attr.name} should match`
                                ).eql(attr.value)
                            })
                        }
                    } else {
                        expect(
                            nodeStr(actualNode),
                            'Should have a node from both DOMs'
                        ).eql(nodeStr(expectedNode))
                        return false
                    }

                    return true
                },
                $actual,
                $expected
            )
        })

        it('extracts expected title', () => {
            expect(result.title).eql(expectedMetadata.title)
        })

        it('extracts expected byline', () => {
            expect(result.byline).eql(expectedMetadata.byline)
        })

        it('extracts expected excerpt', () => {
            expect(result.excerpt).eql(expectedMetadata.excerpt)
        })

        it('extracts expected site name', () => {
            expect(result.siteName).eql(expectedMetadata.siteName)
        })

        if (expectedMetadata.dir) {
            it('should extract expected direction', () => {
                expect(result.dir).eql(expectedMetadata.dir)
            })
        }

        if (expectedMetadata.lang) {
            it('should extract expected language', () => {
                expect(result.lang).eql(expectedMetadata.lang)
            })
        }

        if (expectedMetadata.publishedTime) {
            it('should extract expected published time', () => {
                expect(result.publishedTime).eql(expectedMetadata.publishedTime)
            })
        }
    })
}

describe('#parse', () => {
    const data = getTestPagesData(testPages[0]!)

    it("shouldn't parse oversized documents as per configuration", () => {
        const $ = load('<html><div>yo</div></html>')
        expect(() => {
            new Readability($, { maxElemsToParse: 1 }).parse()
        }).to.Throw('Aborting parsing document; 4 elements found')
    })

    it('should use custom video regex sent as option', () => {
        const $ = load(
            '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nunc mollis leo lacus, vitae semper nisl ullamcorper ut.</p>' +
                '<iframe src="https://mycustomdomain.com/some-embeds"></iframe>'
        )
        const expected_xhtml =
            '<div id="readability-page-1" class="page">' +
            '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nunc mollis leo lacus, vitae semper nisl ullamcorper ut.</p>' +
            '<iframe src="https://mycustomdomain.com/some-embeds"></iframe>' +
            '</div>'

        const content = new Readability($, {
            charThreshold: 20,
            allowedVideoRegex: /.*mycustomdomain.com.*/,
        }).parse().content

        expect(content).eql(expected_xhtml)
    })
})

describe('Test pages', () => {
    testPages.forEach((testPage) => {
        const data = getTestPagesData(testPage)
        const uri = 'http://fakehost/test/page.html'

        runTestsWithItems(
            data.dir,
            (source) => load(source!, { baseURI: uri }),
            data.source,
            data.expectedContent,
            data.expectedMetadata
        )
    })
})
