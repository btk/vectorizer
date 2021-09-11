const potrace = require("potrace");
const fs = require("fs-extra");
const sharp = require("sharp");
const tinycolor = require("tinycolor2");
const quantize = require("quantize");
const SVGO = require("svgo");
const NearestColor = require("nearest-color");
const replaceAll = require("string.prototype.replaceall");
replaceAll.shim();

// https://stackoverflow.com/a/39077686
const hexToRgb = (hex) =>
  hex
    .replace(
      /^#?([a-f\d])([a-f\d])([a-f\d])$/i,
      (m, r, g, b) => "#" + r + r + g + g + b + b
    )
    .substring(1)
    .match(/.{2}/g)
    .map((x) => parseInt(x, 16));

// https://stackoverflow.com/a/35663683
function hexify(color) {
  var values = color
    .replace(/rgba?\(/, "")
    .replace(/\)/, "")
    .replace(/[\s+]/g, "")
    .split(",");
  var a = parseFloat(values[3] || 1),
    r = Math.floor(a * parseInt(values[0]) + (1 - a) * 255),
    g = Math.floor(a * parseInt(values[1]) + (1 - a) * 255),
    b = Math.floor(a * parseInt(values[2]) + (1 - a) * 255);
  return (
    "#" +
    ("0" + r.toString(16)).slice(-2) +
    ("0" + g.toString(16)).slice(-2) +
    ("0" + b.toString(16)).slice(-2)
  );
}

// https://graphicdesign.stackexchange.com/a/91018
function combineOpacity(a, b) {
  return 1 - (1 - a) * (1 - b);
}

function getSolid(svg) {
  svg = svg.replaceAll(`fill="black"`, "");
  const opacityRegex = /fill-opacity="[\d\.]+"/gi;
  const numberRegex = /[\d\.]+/;
  const matches = svg.match(opacityRegex);
  const colors = Array.from(new Set(matches))
    .map((fillOpacity) => ({
      fillOpacity,
      opacity: Number(fillOpacity.match(numberRegex)[0]),
    }))
    .sort((a, b) => b.opacity - a.opacity)
    .map(({ fillOpacity, opacity }, index, array) => {
      // combine all lighter opacities into dark opacity
      const lighterColors = array.slice(index);
      const trueOpacity = lighterColors.reduce(
        (acc, cur) => combineOpacity(acc, cur.opacity),
        0
      );
      // turn opacity into hex
      const hex = hexify(`rgba(0, 0, 0, ${trueOpacity})`);
      return {
        trueOpacity,
        fillOpacity,
        opacity,
        hex,
      };
    });
  for (const color of colors) {
    console.log(color.fillOpacity);
    svg = svg.replaceAll(color.fillOpacity, `fill="${color.hex}" stroke-width="1" stroke="${color.hex}"`);
    svg = svg.replaceAll(` stroke="none"`, "");
    console.log(svg);
  }
  return svg;
}

async function getPixels(input) {
  const image = sharp(input);
  const metadata = await image.metadata();
  const raw = await image.raw().toBuffer();

  const pixels = [];
  for (let i = 0; i < raw.length; i = i + metadata.channels) {
    const pixel = [];
    for (let j = 0; j < metadata.channels; j++) {
      pixel.push(raw.readUInt8(i + j));
    }
    pixels.push(pixel);
  }
  return { pixels, ...metadata };
}

async function replaceColors(svg, original) {
  // if greyscale image, return greyscale svg
  if ((await (await sharp(original).metadata()).channels) === 1) {
    return svg;
  }

  const hexRegex = /#([a-f0-9]{3}){1,2}\b/gi;
  const matches = svg.match(hexRegex);
  const colors = Array.from(new Set(matches));
console.log(colors);
  const pixelIndexesOfNearestColors = {}; // hex: [array of pixel indexes]
  colors.forEach((color) => (pixelIndexesOfNearestColors[color] = []));

  const svgPixels = await getPixels(Buffer.from(svg));

  const nearestColor = NearestColor.from(colors);

  svgPixels.pixels.forEach((pixel, index) => {
    // curly braces for scope https://stackoverflow.com/a/49350263
    switch (svgPixels.channels) {
      case 3: {
        const [r, g, b] = pixel;
        const rgb = `rgb(${r}, ${g}, ${b})`;
        const hex = hexify(rgb);
        pixelIndexesOfNearestColors[nearestColor(hex)].push(index);
        break;
      }
      case 4: {
        const [r, g, b, a] = pixel;
        const rgba = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
        const hex = hexify(rgba);
        pixelIndexesOfNearestColors[nearestColor(hex)].push(index);
        break;
      }
      default:
        throw new Error("Unsupported number of channels");
    }
  });

  const originalPixels = await getPixels(original);
  const pixelsOfNearestColors = pixelIndexesOfNearestColors;
  Object.keys(pixelsOfNearestColors).forEach((hexKey) => {
    pixelsOfNearestColors[hexKey] = pixelsOfNearestColors[hexKey].map(
      (pixelIndex) => {
        const pixel = originalPixels.pixels[pixelIndex];
        switch (originalPixels.channels) {
          case 3: {
            const [r, g, b] = pixel;
            const rgb = `rgb(${r}, ${g}, ${b})`;
            return hexify(rgb);
          }
          case 4: {
            const [r, g, b, a] = pixel;
            const rgba = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
            return hexify(rgba);
          }
          default:
            throw new Error("Unsupported number of channels");
        }
      }
    );
  });

  const colorsToReplace = pixelsOfNearestColors;
  // get palette of 5 https://github.com/lokesh/color-thief/blob/master/src/color-thief-node.js#L61
  Object.keys(pixelsOfNearestColors).forEach((hexKey) => {
    const pixelArray = colorsToReplace[hexKey].map(hexToRgb);
    const colorMap = quantize(pixelArray, 5);
    const [r, g, b] = colorMap.palette()[0];
    const rgb = `rgb(${r}, ${g}, ${b})`;
    colorsToReplace[hexKey] = hexify(rgb);
  });
  Object.entries(colorsToReplace).forEach(([oldColor, newColor]) => {
    svg = svg.replaceAll(oldColor, newColor);
  });

  return svg;
}

async function start() {
  let imageName = "image-asset";
  let svg = await new Promise((resolve, reject) => {
    potrace.posterize(
      "./"+imageName+".png",
      {
        // number of colors
        optTolerance: 0.5,
        steps: [40, 85, 135, 180, 220]
      },
      function (err, svg) {
        if (err) return reject(err);
        resolve(svg);
      }
    );
  });
  svg = getSolid(svg);
  svg = await replaceColors(svg, await fs.readFile("./"+imageName+".png"));
  svg = (await SVGO.optimize(svg)).data;
  fs.outputFileSync("./"+imageName+".svg", svg);
  console.log("done");
}
start();
