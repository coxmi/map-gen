import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mapshaper from 'mapshaper'

// resolve against the project root so callers work from any directory
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const datasets = {
    admin_0: path.join(root, 'data/ne_10m_admin_0_countries/ne_10m_admin_0_countries.shp'),
    admin_1: path.join(root, 'data/ne_10m_admin_1_states_provinces/ne_10m_admin_1_states_provinces.shp')
}

// mapshaper exports a geometry collection instead of a feature collection
// when a filter matches nothing
function featuresOf(geojson) {
    return geojson.features ?? []
}

// read a shapefile as geojson, optionally keeping only records where field
// equals one of values
export async function read(file, { field, values } = {}) {
    // the data is not shipped with the package, so say which command fixes it
    try {
        await fs.access(file)
    } catch {
        throw new Error(`no data at ${file}, run map-fetch to download it`)
    }

    const filter = field && values?.length
        ? `-filter '${values.map(value => `${field} == "${value}"`).join(' || ')}'`
        : ''

    const result = await mapshaper.applyCommands(
        `-i "${file}" ${filter} -o format=geojson data.json`
    )
    return featuresOf(JSON.parse(result['data.json']))
}
