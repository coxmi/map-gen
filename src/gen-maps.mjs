#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import mapshaper from 'mapshaper'
import { datasets, read } from './naturalearth.mjs'
import { readConfig } from './jsonc.mjs'

// output follows wherever the command was run, not wherever it is installed
const outputDir = path.resolve('output')
const simplify = 'dp 40%'
const projection = 'webmercator'

// long side of the svg in px, short side follows the content's aspect ratio
const maxDimension = 1000

// a stack trace buries the one line that says what went wrong
function fail(error) {
    console.error(error.message)
    process.exit(1)
}

// filled in by main, the helpers below have to reach them
let maps
let countryCodes

function collectCoordinates(value, coordinates = []) {
    if (typeof value[0] === 'number') {
        coordinates.push(value)
        return coordinates
    }
    for (const child of value) collectCoordinates(child, coordinates)
    return coordinates
}

function emptyBox() {
    return { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity }
}

function growBox(box, coordinates) {
    for (const [x, y] of collectCoordinates(coordinates)) {
        box.west = Math.min(box.west, x)
        box.east = Math.max(box.east, x)
        box.south = Math.min(box.south, y)
        box.north = Math.max(box.north, y)
    }
    return box
}

function getBounds(geojson) {
    const box = emptyBox()
    for (const feature of geojson.features) {
        // simplify reduces tiny polygons to null geometry
        if (feature.geometry) growBox(box, feature.geometry.coordinates)
    }
    return box
}

// names come from the dataset, so a typo should say what is actually available
function unknownPlace(key, places) {
    const near = [...places.names.keys()].filter(name =>
        name.toLowerCase().includes(key.toLowerCase())
    )
    const hint = near.length ? `. did you mean ${near.join(' or ')}?` : ''
    return `no place named "${key}" in admin_1${hint}`
}

// parse the shapefile once for every map, filtered down to the countries the
// config actually asks for
async function readCountries() {
    return {
        type: 'FeatureCollection',
        features: await read(datasets.admin_0, { field: 'ISO_A2', values: countryCodes })
    }
}

// admin_0 names countries only, so the named places a config excludes come
// from admin_1. both datasets key on the same country codes
async function readPlaces() {
    return indexPlaces(await read(datasets.admin_1, { field: 'iso_a2', values: countryCodes }))
}

// names are not unique (ireland has a cork county and a cork city) and the
// iso_3166_2 code is not unique either, since natural earth gives both IE-CO.
// keep every match and the type that tells them apart
function indexPlaces(features) {
    const names = new Map()
    const codes = new Map()

    for (const feature of features) {
        const { name, iso_3166_2, type_en } = feature.properties
        const place = { code: iso_3166_2, type: type_en, feature }
        names.set(name, (names.get(name) ?? []).concat(place))
        if (iso_3166_2) codes.set(iso_3166_2, (codes.get(iso_3166_2) ?? []).concat(place))
    }

    return { names, codes }
}

// when a name is ambiguous the code only helps if it actually separates the
// matches, so say which case this is rather than always pointing at the code
function ambiguousPlace(key, matches) {
    const kinds = [...new Set(matches.map(match => match.type).filter(Boolean))]
    const codes = [...new Set(matches.map(match => match.code).filter(Boolean))]
    const detail = kinds.length ? ` (${kinds.join(', ')})` : ''
    const hint = codes.length > 1
        ? `. their codes are ${codes.join(', ')}, which do separate them`
        : '. natural earth gives them one shared code, so no code picks out just one'
    return `"${key}" matches ${matches.length} places${detail}${hint}`
}

function findPlaces(key, places) {
    const byCode = places.codes.get(key)
    if (byCode) return byCode

    const matches = places.names.get(key)
    if (!matches) throw new Error(unknownPlace(key, places))
    if (matches.length > 1) throw new Error(ambiguousPlace(key, matches))
    return [matches[0]]
}

function explode(feature) {
    if (feature.geometry.type !== 'MultiPolygon') return [feature]
    return feature.geometry.coordinates.map(coordinates => ({
        ...feature,
        geometry: { type: 'Polygon', coordinates }
    }))
}

function selectCountries(world, { include, exclude = [] }, places) {
    const codes = new Set(include)
    const features = world.features
        .filter(feature => codes.has(feature.properties.ISO_A2))
        .flatMap(explode)

    return {
        countries: { type: 'FeatureCollection', features },
        exclusions: exclude.flatMap(name =>
            findPlaces(name, places).map(match => match.feature)
        )
    }
}

function tag(feature, kind) {
    return {
        ...feature,
        properties: { ...feature.properties, __mapshaper_kind: kind }
    }
}

async function erase(countries, exclusions) {
    if (!exclusions.length) return countries

    const input = {
        type: 'FeatureCollection',
        features: [
            ...countries.features.map(feature => tag(feature, 'countries')),
            ...exclusions.map(feature => tag(feature, 'exclusions'))
        ]
    }
    const result = await mapshaper.applyCommands(
        '-i input.json -split __mapshaper_kind -erase source=exclusions target=countries -o format=geojson geojson-type=FeatureCollection target=countries erased.json',
        { 'input.json': JSON.stringify(input) }
    )
    return JSON.parse(result['erased.json'])
}

// simplify before measuring geographic bounds, then project that same geometry
async function simplifyGeojson(geojson) {
    const result = await mapshaper.applyCommands(
        `-i input.json -simplify ${simplify} -o format=geojson geojson-type=FeatureCollection simplified.json`,
        { 'input.json': JSON.stringify(geojson) }
    )
    return JSON.parse(result['simplified.json'])
}

async function project(geojson) {
    const result = await mapshaper.applyCommands(
        `-i input.json -proj ${projection} -o format=geojson geojson-type=FeatureCollection projected.json`,
        { 'input.json': JSON.stringify(geojson) }
    )
    return JSON.parse(result['projected.json'])
}

function sizeForBounds({ north, east, south, west }) {
    const width = east - west
    const height = north - south
    const scale = maxDimension / Math.max(width, height)
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    }
}

// mapshaper's own frame follows the unprojected bbox, which leaves dead space
// around the map. svg-bbox pins the viewBox to the projected content instead.
async function renderSvg(geojson, { north, east, south, west }, size) {
    const bbox = [west, south, east, north].join(',')
    const result = await mapshaper.applyCommands(
        [
            '-i input.json',
            '-o format=svg',
            // margin keeps strokes from being clipped at the viewBox edge
            'margin=1',
            `svg-bbox=${bbox}`,
            `width=${size.width}`,
            `height=${size.height}`,
            'output.svg'
        ].join(' '),
        { 'input.json': JSON.stringify(geojson) }
    )
    return result['output.svg'].toString()
}

function readViewBox(svg) {
    const tag = svg.match(/<svg\b[^>]*>/)[0]
    return tag.match(/viewBox="([^"]+)"/)[1].trim().split(/\s+/).map(Number)
}


async function main() {
    const args = process.argv.slice(2)

    // the config is always explicit, there is no default to fall back on
    if (!args[0] || args[0].startsWith('-')) {
        console.error('usage: map-gen <config>')
        process.exit(1)
    }

    // which maps to generate
    maps = await readConfig(args[0])
    countryCodes = [...new Set(Object.values(maps).flatMap(m => m.include))]

    const world = await readCountries()
    const places = await readPlaces()

    await fs.mkdir(outputDir, { recursive: true })

    const built = []

    for (const [code, config] of Object.entries(maps)) {
        const selected = selectCountries(world, config, places)

        // json config gets no syntax checking, and a code that matches no ISO_A2
        // would otherwise go on to produce an empty or broken svg
        if (!selected.countries.features.length) {
            throw new Error(`${code} matched no country, check the include codes against ISO_A2`)
        }
        const countries = await erase(selected.countries, selected.exclusions)
        const simplified = await simplifyGeojson(countries)
        const geographicBounds = getBounds(simplified)
        if (!Number.isFinite(geographicBounds.east)) {
            throw new Error(`${code} matched no area after exclusions`)
        }
        const projected = await project(simplified)
        const projectedBounds = getBounds(projected)        
        const size = sizeForBounds(projectedBounds)
        const svg = await renderSvg(projected, projectedBounds, size)
        const viewBox = readViewBox(svg)

        const metadata = {
            code,
            projection,
            bounds: geographicBounds,
            width: viewBox[2],
            height: viewBox[3],
            viewBox
        }

        await fs.writeFile(path.join(outputDir, `${code}.svg`), svg)
        await fs.writeFile(
            path.join(outputDir, `${code}.json`),
            JSON.stringify(metadata, null, 4) + '\n'
        )
        built.push(code)
    }

    // an empty config is almost always a mistake, and silence would hide it
    if (!built.length) {
        console.error(`no maps in ${args[0]}`)
        process.exit(1)
    }

    console.log(`generated ${built.length} map${built.length === 1 ? '' : 's'}: ${built.join(', ')}`)
}

main().catch(fail)
