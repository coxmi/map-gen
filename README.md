# map-gen

Builds svg maps of country data as web mercator projections, plus a matching metadata file for each, using [Natural Earth](https://www.naturalearthdata.com/) data. 

## Install

```sh
# install deps
npm install
# fetch latest natural earth data
npm run fetch
```

## Run

```sh
# copy config and edit to your liking
cp src/maps.example.jsonc src/maps.jsonc

# generate maps from the config
npm run gen src/maps.jsonc

# search for a location to include/exclude in the config
# use a `!` to show all results
npm run search <keyword>!

```


## Config

Example config in `src/maps.example.jsonc`.

Each key is a map name and writes a matching pair of files in `output/`:

```jsonc
{
    "gb": {
        "include": ["GB", "IE"],
        // Sorry Shetland, but you make maps of the British Isles awkward
        "exclude": ["Shetland Islands"]
    }
}
```

- `include` — `ISO_A2` codes of the countries to draw.
- `exclude` — `admin_1` names, or `iso_3166_2` codes, to cut out. Run
  `npm run search` to find them.


## Output

Each map gets an `.svg` sized so its longest side is 1000px, and a `.json`
alongside it holding the projection, geographic bounds and final dimensions.
