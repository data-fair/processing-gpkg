# <img alt="Data FAIR logo" src="https://cdn.jsdelivr.net/gh/data-fair/data-fair@master/ui/public/assets/logo.svg" width="30"> @data-fair/processing-gpkg

A plugin that allows the creation and management of datasets from geopackage files or zip files that contain them.

## Features

- **List layers** — Lists the layers and corresponding information in your file
- **Dataset management** — Create or update a REST or file dataset from the desired layers, configurable from the processing parameters.
- **Graceful stop** — honours the stop signal from the platform and exits cleanly mid-run; optionally, the stop can be ignored to test forced termination after timeout.

## Configuration

The plugin configurations change depending on the datasetMode to be applied. There are three of them:
- `list` to list the different layers
- `create` to create a new dataset
- `update` to target an existing one

Overall, only the URL in the settings tab remains common, representing a stable URL from which the data file is downloaded (this is the only possible option, there is no repository).

### list

For this mode, you only need to enter the URL in the Parameters tab.

### create

| Tab | Field | Description |
| --- | ----- | ----------- |
| Datasets | `editableCreate` | By default, file-based datasets are created ; by checking this box, editable datasets can be created |
| File layers | `addAllLayers` | Allows you to build datasets directly for all layers of the file |
| File layers - Layers | `add` | Allows you to build a dataset with the corresponding layer by checking the box |
| File layers - Layers | `title` | This corresponds to the name you want for your dataset. By default, the title will be the layer name. |

### update

| Tab | Field | Description |
| --- | ----- | ----------- |
| Datasets | `editableUpdate` | By default, file-based datasets are updated; checking this box allows you to update editable datasets. However, be careful to select datasets that correspond to the correct mode. In case of errors, the update should be blocked. |
| Datasets | `datasets` | List of datasets to be updated, taking into account the layer and the schema update forcing |
| Datasets - Datasets to update | `dataset` | Name of the dataset to update, selectable from the list of available datasets |
| Datasets - Datasets to update | `layer` | Name of the layer from which the update should be made, selectable from the list of available layers. |
| Datasets - Datasets to update | `forceUpdate` | Indicates whether the scheme update should also be forced |

## Release

Publishing is handled automatically by CI: the plugin is pushed to the data-fair registry (`@data-fair/registry`), not to the public npm registry — there is no manual `npm publish`. A push to `main`/`master` publishes to the staging registry; pushing a `v*` tag publishes to production:

```bash
npm version minor       # version bump + v* tag
git push --follow-tags  # CI publishes to the production registry
```