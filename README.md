# <img alt="Data FAIR logo" src="https://cdn.jsdelivr.net/gh/data-fair/data-fair@master/ui/public/assets/logo.svg" width="30"> @data-fair/processing-hello-world

Minimal reference plugin for [data-fair/processings](https://github.com/data-fair/processings). Designed to serve as a working example and a test bed for the processings platform.

## Features

- **Dataset management** — create a new REST dataset or update an existing one, configurable from the processing settings.
- **Welcome message** — writes a single line into the dataset combining the plugin-level message and the processing-level message.
- **Configurable delay** — introduces a pause (in seconds) between steps, useful for testing task interruption and graceful stop behavior.
- **Graceful stop** — honours the stop signal from the platform and exits cleanly mid-run; optionally, the stop can be ignored to test forced termination after timeout.
- **Error handling test** — can deliberately throw an error to verify that the platform correctly captures and reports failures.
- **Secret field** — stores a sensitive value encrypted in the database; the decrypted value is displayed in the dataset description to confirm the processing receives it correctly.
- **Email sending** — optionally sends a test email with an attachment via the platform mail service.
- **Progress logging** — runs a 100-step simulated task to exercise the progress reporting API.
- **Auto-deletion of run** — can return `{ deleteOnComplete: true }` to instruct the platform to automatically remove the run entry from history after successful completion.

## Configuration

| Tab | Field | Description |
| --- | ----- | ----------- |
| Jeu de données | `datasetMode` | `create` to create a new dataset, `update` to target an existing one |
| Options de tests | `message` | Text appended to the plugin message and written to the dataset |
| Options de tests | `delay` | Pause in seconds before writing the line |
| Options de tests | `secretField` | Sensitive value stored encrypted; shown decrypted in the dataset description |
| Options de tests | `ignoreStop` | When enabled, the processing ignores the stop signal (tests forced kill) |
| Options de tests | `throwError` | When enabled, the processing throws an intentional error |
| Options de tests | `deleteOnComplete` | When enabled, the run is automatically deleted from history after execution |
| Email | `email.from` / `email.to` | If both are set, a test email with attachment is sent during the run |

## Release

Processing plugins are fetched from the npm registry with a filter on keyword "data-fair-processings-plugin". So publishing a plugin is as simple as publishing the npm package:

```bash
npm version minor
npm publish
git push --follow-tags
```
