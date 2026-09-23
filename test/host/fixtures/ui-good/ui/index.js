// The browser module of the ui-good fixture. The shell calls install(ext) once after the page mounts.
export default function install(ext) {
  ext.dock("good", { draw: () => ({ title: "Good", body: document.createTextNode("good") }) });
}
