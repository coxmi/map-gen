#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { datasets } from './naturalearth.mjs'

const run = promisify(execFile)

const base = 'https://naturalearth.s3.amazonaws.com/10m_cultural'

// the archive may or may not wrap the files in a folder, so locate the
// shapefile in the staging dir rather than assuming a flat layout
async function findShapefile(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            const found = await findShapefile(full)
            if (found) return found
        } else if (entry.name.endsWith('.shp')) {
            return full
        }
    }
    return null
}

for (const file of Object.values(datasets)) {
    const name = path.basename(file, '.shp')
    const url = `${base}/${name}.zip`
    const stage = await mkdtemp(path.join(tmpdir(), 'ne-'))
    const archive = path.join(stage, 'data.zip')
    const unpacked = path.join(stage, 'unpacked')

    process.stdout.write(`${name} ... `)

    try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`${url} returned ${response.status}`)
        await writeFile(archive, Buffer.from(await response.arrayBuffer()))

        try {
            await run('unzip', ['-q', '-o', archive, '-d', unpacked])
        } catch {
            throw new Error('unzip is required to unpack the download')
        }

        const shp = await findShapefile(unpacked)
        if (!shp) throw new Error(`no .shp found inside ${url}`)

        // the sidecars share the shapefile name, so copy them across together
        const target = path.dirname(file)
        const prefix = path.basename(shp, '.shp')
        await mkdir(target, { recursive: true })
        for (const sidecar of await readdir(path.dirname(shp))) {
            if (sidecar.startsWith(prefix)) {
                await copyFile(path.join(path.dirname(shp), sidecar), path.join(target, sidecar))
            }
        }

        const { size } = await stat(shp)
        console.log(`${(size / 1024 / 1024).toFixed(1)} MB`)
    } catch (error) {
        console.log('failed')
        throw error
    } finally {
        await rm(stage, { recursive: true, force: true })
    }
}
