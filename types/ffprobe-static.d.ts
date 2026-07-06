/**
 * Minimal ambient types for `ffprobe-static`, which ships without its own
 * declarations. It exposes the absolute path to a bundled ffprobe binary (plus
 * the resolved platform/arch), downloaded by its install script.
 */
declare module "ffprobe-static" {
  interface FfprobeStatic {
    /** Absolute path to the bundled ffprobe binary. */
    path: string;
    /** Platform the binary was resolved for (e.g. "linux"). */
    platform: string;
    /** Architecture the binary was resolved for (e.g. "x64"). */
    arch: string;
  }

  const ffprobeStatic: FfprobeStatic;
  export default ffprobeStatic;
}
