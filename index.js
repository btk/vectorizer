import potrace from "potrace";
import fs from "fs-extra";
import sharp from "sharp";
import tinycolor from "tinycolor2";
import quantize from "quantize";
import SVGO from "svgo";
import NearestColor from "nearest-color";
import replaceAll from "string.prototype.replaceall";
import getColors from 'get-image-colors';

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

function getSolid(svg, stroke) {
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
    if(stroke){
      svg = svg.replaceAll(color.fillOpacity, `fill="${color.hex}" stroke-width="1" stroke="${color.hex}"`);
      svg = svg.replaceAll(` stroke="none"`, "");
    }else{
      svg = svg.replaceAll(color.fillOpacity, `fill="${color.hex}"`);
      svg = svg.replaceAll(` stroke="none"`, "");
    }
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

function viewBoxify(svg){
  let width = svg.split('width="')[1].split('"')[0];
  let height = svg.split('height="')[1].split('"')[0];

  let originalHeader = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  return svg.replace(originalHeader, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`);
}

async function parseImage(imageName, step, colors) {

  let svg = await new Promise((resolve, reject) => {
    potrace.posterize(
      "./"+imageName+".png",
      {
        // number of colors
        optTolerance: 0.5,
        steps: step
      },
      function (err, svg) {
        if (err) return reject(err);
        resolve(svg);
      }
    );
  });

  svg = getSolid(svg, step != 1);

  if(step == 1){
    let paths = svg.split("<path");
    svg = paths[0]+"<path"+paths[2];
    let color = svg.split('#')[1].split('"')[0];
    svg = svg.replaceAll("#"+color, colors[0]);
  }else{
    svg = await replaceColors(svg, await fs.readFile("./"+imageName+".png"));
  }

  svg = (await SVGO.optimize(svg)).data;

  svg = viewBoxify(svg);

  fs.outputFileSync("./"+imageName+".svg", svg);
  console.log("done");
}

async function inspectImage(imageName){
  let options = [];

  let listColors = await getColors("./"+imageName+".png", {count: 5});

  let hslList = listColors.map(color => color.hsl());
  let rgbList = listColors.map(color => color.rgb());
  let hexList = listColors.map(color => color.hex());

  let isWhiteBackground = hslList[0][2] > 0.80;
  if(isWhiteBackground){
    hslList = hslList.slice(1);
    rgbList = rgbList.slice(1);
    hexList = hexList.slice(1);
  }

  let isBlackAndWhite = hslList[hslList.length - 1][2] < 0.05;

  if(isNaN(hslList[hslList.length-1][0])){
    isBlackAndWhite = true;
  }

  if(isBlackAndWhite){
    options.push({step: 1, colors: ["#000000"]});

  }else{

    let hueArray = hslList.map((color, i) => {
      if(isNaN(color[0])){
        return 0;
      }else{
        return color[0];
      }
    });

    let lumArray = hslList.map((color, i) => {
      if(isNaN(color[2])){
        return 0;
      }else{
        return color[2];
      }
    });

    let hueDifference = 0;
    let lumDifference = 0;
    for (var i = 0; i < hueArray.length; i++) {
      if(i != 0){
        hueDifference += Math.abs(hueArray[i-1] - hueArray[i]);
        lumDifference += Math.abs(lumArray[i-1] - lumArray[i]);
      }
    }

    let isMonocolor = hueDifference < 5 && lumDifference < 2;

    if(isMonocolor){
      options.push({step: 1, colors: [hexList[hexList.length-1]]});
    }else{
      options.push({step: 1, colors: hexList.slice(0,1)});
      options.push({step: 2, colors: hexList.slice(0,2)});
      options.push({step: 3, colors: hexList.slice(0,3)});
      options.push({step: 4, colors: hexList.slice(0,4)});
    }

  }

  return options;

}


export  { inspectImage, parseImage };
