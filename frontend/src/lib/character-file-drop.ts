const CHARACTER_FILE_EXTENSION = /\.(json|png|charx|jpe?g)$/i

export function characterFilesFromDrop(files: ArrayLike<File>): File[] {
  return Array.from(files).filter((file) => CHARACTER_FILE_EXTENSION.test(file.name))
}
