#!/usr/bin/env node

import { styleText } from 'node:util'
import { datasets, read } from './naturalearth.mjs'

// hasColors only exists on a tty, so a plain pipe must not pick up escapes
const canColour = typeof process.stdout.hasColors === 'function' && process.stdout.hasColors()
const paint = (format, text) => canColour ? styleText(format, text) : text

// a stack trace buries the one line that says what went wrong
function fail(error) {
    console.error(error.message)
    process.exit(1)
}

// filled in by main, the helpers below have to reach it
let all = false

// what a match is worth, so a hit on a real name outranks one that only came
// from a country or sovereign field
const weights = {
    admin_0: {
        NAME: 1, NAME_EN: 0.7, NAME_LONG: 0.6, NAME_ALT: 0.5,
        BRK_NAME: 0.4, NAME_SORT: 0.3, ADMIN: 0.2, SOVEREIGNT: 0.2
    },
    admin_1: {
        name: 1, name_alt: 0.6, name_en: 0.6, name_local: 0.5,
        gn_name: 0.4, gns_name: 0.4, woe_name: 0.4, geonunit: 0.1, admin: 0.1
    }
}

const columns = {
    admin_0: { label: 'Countries', name: 'NAME', code: 'ISO_A2', type: 'TYPE', country: 'ISO_A2' },
    admin_1: { label: 'Places', name: 'name', code: 'iso_3166_2', type: 'type_en', country: 'iso_a2' }
}

const cutOff = 0.4

// an exact name match is the one worth picking out, a near miss is still
// usable, and the long tail just gets dimmed
const strong = 0.9
// default cap on rows printed, a bang lifts it along with the cut-off
const limit = 50

function scoreColour(value) {
    if (value >= 1) return 'green'
    return value >= strong ? 'yellow' : 'dim'
}

// floor widths so short results do not leave a cramped table
const spacing = [26, 10, 26, 5, 10]

// a name starting with the keyword beats one that merely contains it
function strength(value, needle) {
    const text = String(value ?? '')
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) return 0
    if (at > 0) return /[\s\-_('/]/.test(text[at - 1]) ? 0.7 : 0.5
    return text.length === needle.length ? 1 : 0.9
}

// report which field won as well, so a row can be traced back to its source
function score(properties, weight, needle) {
    let best = 0
    let field = null

    for (const [name, value] of Object.entries(weight)) {
        const hit = value * strength(properties[name], needle)
        if (hit > best) {
            best = hit
            field = name
        }
    }
    return { value: best, field }
}

// natural earth marks countries with no real ISO_A2 as -99, which would read
// as a code but resolve to nothing
function showCode(key, properties) {
    const code = properties[columns[key].code] || ''
    return key === 'admin_0' && code === '-99'
        ? `${properties.ADM0_A3} (ISO_A2 ${code})`
        : code
}

function findMatches(features, key, needle) {
    const { name } = columns[key]
    const matches = []
    const weak = []

    for (const feature of features) {
        const { value, field } = score(feature.properties, weights[key], needle)
        if (value <= 0) continue
        // collect the weak tier either way, because the country fallback reads
        // it even when a bang has already lifted those rows into the results
        if (value < cutOff) {
            weak.push({ feature, value, field })
            if (!all) continue
        }
        matches.push({ feature, value, field })
    }

    const byScore = (a, b) =>
        b.value - a.value ||
        String(a.feature.properties[name]).localeCompare(String(b.feature.properties[name]))

    matches.sort(byScore)
    weak.sort(byScore)

    return { matches, weak, hidden: all ? 0 : weak.length }
}

function report(key, matches, note = '') {
    const { label, name, type } = columns[key]
    const shown = all ? matches : matches.slice(0, limit)
    const rows = shown.map(({ feature, value, field }) => {
        const properties = feature.properties
        return {
            cells: [
                properties[name] || '(no name)',
                showCode(key, properties) || '-',
                properties[type] || '-',
                value === undefined ? '-' : `${Math.round(value * 100)}%`,
                field || '-'
            ],
            value
        }
    })

    const header = ['NAME', 'CODE', 'TYPE', 'SCORE', 'MATCHED']
    const widths = header.map((cell, i) =>
        Math.max(spacing[i], cell.length, ...rows.map(row => row.cells[i].length))
    )
    // the score reads as a number, so right align it, and leave the last
    // column bare rather than pad the end of the line
    const scoreAt = header.indexOf('SCORE')
    const cell = (text, i) => i === header.length - 1
        ? text
        : i === scoreAt
            ? text.padStart(widths[i])
            : text.padEnd(widths[i])

    console.log(`\n${paint('bold', label)} ${paint('dim', `(${key})`)}` +
        (note ? ` ${paint('dim', note)}` : ''))
    console.log(`  ${header.map((text, i) => paint('dim', cell(text, i))).join('  ')}`)

    for (const row of rows) {
        const coloured = [
            paint('bold', cell(row.cells[0], 0)),
            // the code goes straight into the exclude list, so keep it plain
            paint('white', cell(row.cells[1], 1)),
            paint('dim', cell(row.cells[2], 2)),
            paint(row.value === undefined ? 'dim' : scoreColour(row.value), cell(row.cells[3], 3)),
            paint('dim', row.cells[4])
        ]
        console.log(`  ${coloured.join('  ')}`)
    }

    if (matches.length > shown.length) {
        console.log(paint('dim', `  ... and ${matches.length - shown.length} more`))
    }
}

async function main() {
    const args = process.argv.slice(2)
    const banged = args.filter(word => word !== '!')
    const joined = banged.join(' ').trim()

    // a bang asks for everything, duckduckgo style, on the end of the term or
    // standing alone, and it comes back off the search either way
    all = args.length !== banged.length || /!$/.test(joined)
    const query = joined.replace(/!+$/, '').trim()

    if (!query) {
        console.error('usage: map-search <keyword>[!]')
        process.exit(1)
    }

    // the count has to lead, so gather every result before printing anything
    const needle = query.toLowerCase()
    const loaded = {}
    const results = {}
    let total = 0
    let hiddenTotal = 0

    for (const [key, file] of Object.entries(datasets)) {
        loaded[key] = await read(file)
        results[key] = findMatches(loaded[key], key, needle)
        total += results[key].matches.length
        hiddenTotal += results[key].hidden
    }

    // natural earth has no country record for england, wales or scotland, only
    // for the united kingdom, so fall back to the countries the matched places
    // sit in. a stray place can drag in a country that merely shares a word, so
    // only the country holding the most of them is worth showing
    const { country } = columns.admin_1
    const tally = new Map()
    for (const { feature, value, field } of results.admin_1.weak) {
        const code = feature.properties[country]
        const seen = tally.get(code)
        if (!seen) tally.set(code, { count: 1, value, field })
        else {
            seen.count++
            if (value > seen.value) Object.assign(seen, { value, field })
        }
    }

    const top = Math.max(0, ...[...tally.values()].map(entry => entry.count))
    const leading = [...tally].filter(([, entry]) => entry.count === top)
    const derived = results.admin_0.matches.length || !leading.length
        ? []
        : loaded.admin_0
            .filter(feature => leading.some(([code]) => code === feature.properties.ISO_A2))
            .map(feature => {
                const entry = leading.find(([code]) => code === feature.properties.ISO_A2)[1]
                return { feature, field: entry.field }
            })

    let headline = `${paint('yellow', String(total))} ` +
        `${paint('white', `${total === 1 ? 'match' : 'matches'} for`)} ` +
        paint('yellow', `"${query}"`)

    if (hiddenTotal) {
        headline += `, ${paint('yellow', String(hiddenTotal))} ` +
            paint('white', `weaker match${hiddenTotal === 1 ? '' : 'es'} hidden, use !`)
    }

    console.log(`\n${headline}`)

    if (results.admin_0.matches.length) {
        report('admin_0', results.admin_0.matches)
    } else if (derived.length) {
        const count = results.admin_1.weak.length
        report('admin_0', derived, `via ${count} matching place${count === 1 ? '' : 's'}`)
    }

    if (results.admin_1.matches.length) {
        report('admin_1', results.admin_1.matches)
    } else if (results.admin_1.hidden) {
        console.log(`\n${paint('bold', 'Places')} ${paint('dim', '(admin_1)')} ` +
            paint('dim', `all ${results.admin_1.hidden} below the cut-off, use !`))
    }
}

main().catch(fail)
