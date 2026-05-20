/**
 * Extracts the SRS code from a label like "EPSG:4326 - WGS 84" or returns the
 * value as is if it is already a simple code like "EPSG:4326".
 *
 * @param srs   Raw value coming from the form
 * @returns     The normalized SRS code
 */
export const normalizedSRS = (srs: string): string => {
  if (!srs) {
    return ''
  }
  const match = srs.match(/^(.+) - /)
  return match ? match[1] : srs.trim()
}
