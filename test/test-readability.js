/* eslint-env node, mocha */

const { load } = require('cheerio')
const chai = require('chai')
const sinon = require('sinon')
const REGEXPS = require('../src/regexes')
chai.config.includeStack = true
const expect = chai.expect

const Readability = require('../index').Readability
const { prettyPrint, getTestPages, getTestPagesData } = require('./utils')
const testPages = getTestPages()

function reformatError(err) {
    const formattedError = new Error(err.message)

    formattedError.stack = err.stack
    return formattedError
}

function inOrderTraverse(fromNode) {
    if (fromNode.firstChild) {
        return fromNode.firstChild
    }
    while (fromNode && !fromNode.nextSibling) {
        fromNode = fromNode.parentNode
    }
    return fromNode ? fromNode.nextSibling : null
}

function inOrderIgnoreEmptyTextNodes(node) {
    while (node) {
        node = inOrderTraverse(node)
        if (node && node.type === 'text' && node.data.trim()) {
            break
        }
    }
    return node
}

function traverseDOM(callback, $expected, $actual) {
    let actualNode = $actual.contents()[0]
    let expectedNode = $expected.contents()[0]

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
function htmlTransform(str) {
    return str.replace(/\s+/g, ' ')
}

function runTestsWithItems(
    label,
    domGenerationFn,
    source,
    expectedContent,
    expectedMetadata
) {
    describe(label, function () {
        this.timeout(3000)

        let result
        let $

        before(function () {
            try {
                $ = domGenerationFn(source)
                // Provide one class name to preserve, which we know appears in a few
                // of the test documents.
                const reader = new Readability($, {
                    classesToPreserve: ['caption'],
                    // debug: true,
                })
                result = reader.parse()
            } catch (err) {
                throw reformatError(err)
            }
        })

        it('should return a result object', function () {
            expect(result).to.include.keys(
                'content',
                'title',
                'excerpt',
                'byline'
            )
        })

        it('should extract expected content', function () {
            function nodeStr(n) {
                if (!n) return '(no node)'
                if (n.type == 'text') return `#text(${htmlTransform(n.data)})`
                if (n.type !== 'tag') {
                    return `some other node type: ${n.nodeType} with data ${n.data}`
                }
                let rv = n.tagName
                if (n.attribs?.id) rv += `#${n.attribs?.id}`
                if (n.attribs?.className) rv += `.(${n.attribs?.className})`

                return rv
            }

            function genPath(node) {
                if (node.attribs?.id) return `#${node.attribs?.id}`
                if (node.tagName == 'body') return 'body'

                const parent = node.parentNode
                const parentPath = genPath(parent)
                const index =
                    Array.prototype.indexOf.call(parent.childNodes, node) + 1

                return `${parentPath} > ${nodeStr(node)}:nth-child(${index})`
            }

            function findableNodeDesc(node) {
                return genPath(node) + '(in: ``' + node.parentNode.data + '``)'
            }

            function attributesForNode(node) {
                return Array.from(node.attribs)
                    .map((attr) => attr.name + '=' + attr.value)
                    .join(',')
            }

            const $actual = domGenerationFn(prettyPrint(result.content)).root()
            const $expected = domGenerationFn(
                prettyPrint(expectedContent)
            ).root()

            traverseDOM(
                (actualNode, expectedNode) => {
                    if (actualNode && expectedNode) {
                        const actualDesc = nodeStr(actualNode)
                        const expectedDesc = nodeStr(expectedNode)

                        if (actualDesc != expectedDesc) {
                            expect(
                                actualDesc,
                                findableNodeDesc(actualNode)
                            ).eql(expectedDesc)
                            return false
                        }

                        // Compare text for text nodes:
                        if (actualNode.type === 'text') {
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
                        } else if (actualNode.type === 'tag') {
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

        it('should extract expected title', function () {
            expect(result.title).eql(expectedMetadata.title)
        })

        it('should extract expected byline', function () {
            expect(result.byline).eql(expectedMetadata.byline)
        })

        it('should extract expected excerpt', function () {
            expect(result.excerpt).eql(expectedMetadata.excerpt)
        })

        it('should extract expected site name', function () {
            expect(result.siteName).eql(expectedMetadata.siteName)
        })

        expectedMetadata.dir &&
            it('should extract expected direction', function () {
                expect(result.dir).eql(expectedMetadata.dir)
            })

        expectedMetadata.lang &&
            it('should extract expected language', function () {
                expect(result.lang).eql(expectedMetadata.lang)
            })

        expectedMetadata.publishedTime &&
            it('should extract expected published time', function () {
                expect(result.publishedTime).eql(expectedMetadata.publishedTime)
            })
    })
}

describe('Readability API', function () {
    describe('#constructor', function () {
        const $ = load('<html><div>yo</div></html>')

        it('should accept a debug option', function () {
            expect(new Readability($)._debug).eql(false)
            expect(new Readability($, { debug: true })._debug).eql(true)
        })

        it('should accept a nbTopCandidates option', function () {
            expect(new Readability($)._nbTopCandidates).eql(5)
            expect(
                new Readability($, { nbTopCandidates: 42 })._nbTopCandidates
            ).eql(42)
        })

        it('should accept a maxElemsToParse option', function () {
            expect(new Readability($)._maxElemsToParse).eql(0)
            expect(
                new Readability($, { maxElemsToParse: 42 })._maxElemsToParse
            ).eql(42)
        })

        it('should accept a keepClasses option', function () {
            expect(new Readability($)._keepClasses).eql(false)
            expect(new Readability($, { keepClasses: true })._keepClasses).eql(
                true
            )
            expect(new Readability($, { keepClasses: false })._keepClasses).eql(
                false
            )
        })

        it('should accept a allowedVideoRegex option or default it', function () {
            expect(new Readability($)._allowedVideoRegex).eql(REGEXPS.videos)
            const allowedVideoRegex = /\/\/mydomain.com\/.*'/
            expect(
                new Readability($, { allowedVideoRegex })._allowedVideoRegex
            ).eql(allowedVideoRegex)
        })
    })

    describe('#parse', function () {
        const data = getTestPagesData(testPages[0])
        const exampleSource = data.source

        it("shouldn't parse oversized documents as per configuration", function () {
            const $ = load('<html><div>yo</div></html>')
            expect(function () {
                new Readability($, { maxElemsToParse: 1 }).parse()
            }).to.Throw('Aborting parsing document; 4 elements found')
        })

        it('should run _cleanClasses with default configuration', function () {
            const $ = load(exampleSource)
            const parser = new Readability($)

            parser._cleanClasses = sinon.fake()

            parser.parse()

            expect(parser._cleanClasses.called).eql(true)
        })

        it('should run _cleanClasses when option keepClasses = false', function () {
            const $ = load(exampleSource)
            const parser = new Readability($, { keepClasses: false })

            parser._cleanClasses = sinon.fake()

            parser.parse()

            expect(parser._cleanClasses.called).eql(true)
        })

        it("shouldn't run _cleanClasses when option keepClasses = true", function () {
            const $ = load(exampleSource)
            const parser = new Readability($, { keepClasses: true })

            parser._cleanClasses = sinon.fake()

            parser.parse()

            expect(parser._cleanClasses.called).eql(false)
        })

        it('should use custom video regex sent as option', function () {
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
})

describe('Test pages', function () {
    testPages.forEach(function (testPage) {
        const data = getTestPagesData(testPage)

        describe.only(data.dir, function () {
            const uri = 'http://fakehost/test/page.html'

            runTestsWithItems(
                'cheerio',
                (source) =>
                    load(source, {
                        baseURI: uri,
                    }),
                data.source,
                data.expectedContent,
                data.expectedMetadata
            )
        })
    })
})
