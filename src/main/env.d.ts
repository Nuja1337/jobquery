// Images imported with ?inline arrive as data URLs.
declare module '*.png?inline' {
  const dataUrl: string
  export default dataUrl
}
