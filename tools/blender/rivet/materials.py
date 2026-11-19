"""Surface finishes shared by the RIVET atelier scene and its game export.

The color factor multiplies an sRGB albedo map in linear space. The pale
ripstop tile can therefore be re-dyed for either team without losing its weave.
"""


def linear(rgb):
    def channel(start):
        value = int(rgb[start:start + 2], 16) / 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4
    return tuple(channel(start) for start in (0, 2, 4))


def finish(name, tint, roughness, metalness=0.0, texture=None, **extras):
    result = dict(name=name, color=linear(tint), roughness=roughness, metalness=metalness)
    if texture:
        result["texture"] = "textures/" + texture
    if extras:
        result["extras"] = extras
    return result


MATERIALS = {
    "shell": finish("Shell | chalk ceramic", "e3e6e6", 0.52, 0.06,
                    "palette/ivory-ceramic.jpg", paletteColor=0x26323b, textureBumpScale=0.00012),
    "suit": finish("Suit | patrol shell", "5393a2", 0.82, texture="rivet/ripstop.jpg",
                   slot="suit", textureBumpScale=0.00022),
    "dark": finish("Suit | shadow panels", "374d59", 0.87, texture="rivet/ripstop.jpg",
                   slot="dark", textureBumpScale=0.00022),
    "cloth": finish("Cloth | anthracite twill", "56616a", 0.91, texture="rivet/ripstop.jpg",
                    textureBumpScale=0.00025),
    "rubber": finish("Rubber | carbon grip", "bdc3c3", 0.75, 0.0, "palette/pebbled-rubber.jpg",
                     textureBumpScale=0.00024),
    "leather": finish("Leather | field nubuck", "ffffff", 0.77, texture="rivet/nubuck.jpg",
                      textureBumpScale=0.00024),
    "midsole": finish("Rubber | weathered chalk", "9b9891", 0.84, 0.0,
                      "palette/ivory-ceramic.jpg", textureBumpScale=0.00012),
    "metal": finish("Hardware | bead-blasted titanium", "c1c7ce", 0.37, 0.64,
                    "palette/machined-steel.jpg"),
    "web": finish("Webbing | field khaki", "fffffb", 0.92, 0.0, "rivet/field-webbing.jpg",
                  textureBumpScale=0.00015),
    # The infantry role recolourer also addresses this accent by its name.
    "orange": finish("Armor | rescue orange", "ecded7", 0.49, 0.13, "orange-painted-metal.jpg",
                     textureBumpScale=0.00014),
    "visor": finish("Visor | copper mirror", "fffaf0", 0.16, 0.28,
                    "rivet/copper-lens.jpg", paletteColor=0x6aa5af, repaintTexture="rivet/silver-lens"),
    "ink": finish("Print | bone transfer", "d4cec0", 0.63),
}
