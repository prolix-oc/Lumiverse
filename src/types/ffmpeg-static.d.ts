// This optional package can be absent on architectures without a binary.
declare module "ffmpeg-static" {
  const binary: string | null;
  export default binary;
}
