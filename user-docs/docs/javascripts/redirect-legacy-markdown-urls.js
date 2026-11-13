(() => {
  const { hash, pathname, search } = window.location

  if (!/\.md$/i.test(pathname)) {
    return
  }

  const pagePath = pathname
    .replace(/\/index\.md$/i, '/')
    .replace(/\.md$/i, '/')

  window.location.replace(`${pagePath}${search}${hash}`)
})()
