-- neutralize internal same-document links (href starting with '#') into
-- plain inline content: typst's writer emits #link(<label>) for these,
-- which hard-fails compilation whenever the source epub's html anchors
-- don't line up 1:1 with pandoc's own generated header/span identifiers
-- (common in older/legacy epub exports with multiple stacked anchor ids
-- per heading). we only rasterize pages for a canvas preview here, so
-- link targets don't need to survive.
function Link(el)
  if el.target:sub(1, 1) == "#" then
    return el.content
  end
  return el
end
