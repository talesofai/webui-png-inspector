import * as fs from 'fs';
import * as path from 'path';
import OSS from 'ali-oss';
import ExifReader from 'exifreader';
import * as dotenv from 'dotenv';

dotenv.config();

// 阿里云 OSS 相关配置
const ossClient = new OSS({
  accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
  bucket: process.env.OSS_BUCKET,
  region: process.env.OSS_REGION,
});

// 指定目录路径和文件后缀名
const dirPath = '/Users/tzwm/Downloads/to_be_upload/0425/';
const fileExt = '.png';
const ossBasePath = process.env.OSS_BASE_PATH;
const originalOSSUrl = process.env.OSS_ORIGINAL_OSS_URL || '';
const ossBaseUrl = process.env.OSS_BASE_URL || '';

let data: {[key: string]: any} = {};

async function uploadFileToOSS(filename: string): Promise<string> {
  const filePath = path.join(dirPath, filename);
  let ret: OSS.PutObjectResult;
  try {
    ret = await ossClient.put(ossBasePath + filename, fs.createReadStream(filePath));
    console.log(`${filename} uploaded to OSS successfully.`);
  } catch (err) {
    console.error(err);
    return '';
  }

  return ret.url.replace(originalOSSUrl, ossBaseUrl);
}

async function readITXtChunk(filename: string): Promise<string> {
  const fileDir = path.join(dirPath, filename);
  //const buffer = fs.readFileSync(fileDir);

  const tags = await ExifReader.load(fileDir);
  if (tags['parameters']) {
    return tags['parameters'].description;
  } else {
    return '';
  }
}

function getParameters(key: string): string {
  const dd = data[key];
  let ret = dd['output'];
  for (const i in dd['controlnet']) {
    ret += `,\nControlNet-${i} Image: ${dd['controlnet'][i]}`;
  }

  return ret;
}

function paramsToJSON(key: string) {
  const params = data[key]['output'].split("\n");
  const json = {
    'prompt': params[0],
    'negative': params[1].split(':')[1].trim(),
  }

  return { ...json, ...params[2].split(',').reduce((result: object, item: string) => {
    const [k, v] = item.trim().split(':');
    return k && v ? { ...result, [k.trim()]: v.trim() } : result;
  }, {})};
}

function jsonToTargetPrompts(key: string): object {
  return {
    'prompt': data[key]['json']['prompt'],
    'negative': data[key]['json']['negative'],
  };
}

function jsonToTargetParams(key: string): object {
  const d = data[key]['json'];
  const [width, height] = d['Size'].split('x');

  let controlnetUnits = [];
  for (const i in [0, 1, 2, 3, 4]) {
    const preStr = `ControlNet-${i}`;
    if (!data[key]['output'].match(preStr)) {
      continue;
    }

    controlnetUnits.push({
      "mask": "",
      "module": d[preStr + ' Module'],
      "lowvram": false,
      "guessmode": false,
      "resize_mode": "Scale to Fit (Inner Fit)",
      "guidance_start": +d[preStr + ' Guidance Start'],
      "guidance_end": +d[preStr + ' Guidance End'],
      "model": d[preStr + ' Model'],
      "weight": +d[preStr + ' Weight'],
      "input_image": data[key]['controlnet'][i.toString()],
    });
  }

  let ret: {[key: string]: any} = {
    "extra_jobs": "",
    "task_name": "make_image_with_webui",
    "steps": +d['Steps'],
    "sampler_index": d['Sampler'],
    "cfg_scale": +d['CFG scale'],
    "width": +width,
    "height": +height,
    "base_model_name": d['Model'],
    "controlnet_units": controlnetUnits,
  };

  if (d['Hires upscale']) {
    ret['enable_hr'] = true;
    ret['hr_upscaler'] = d['Hires upscaler'];
    ret['hr_scale'] = d['Hires upscale'];
    ret['denoising_strength'] = d['Denoising strength'];
  }

  return ret;
}

function validParameters(key: string): Array<string> {
  const dd = data[key];
  let errors = [];

  // check controlnet
  for (const i in dd['controlnet']) {
    let str = `ControlNet-${i}`;
    if (dd['output'].indexOf(str) < 0) {
      errors.push(`not found ControlNet-${i} in the parameters`);
    }
  }

  // check width and height
  const MAX_SIZE = 512;
  if (dd['targetParams']['width'] > MAX_SIZE || dd['targetParams']['height'] > MAX_SIZE) {
    errors.push(`the width or height is larger than ${MAX_SIZE}`);
  }

  return errors;
}

async function writeParameters(key: string) {
  const dd = data[key];
  const output = [
    'errors: ' + dd['errors'].join("\n"),
    dd['original'],
    getParameters(key),
    JSON.stringify(dd['targetPrompts'], null, 2),
    JSON.stringify(dd['targetParams'], null, 2),
  ].join("\n\n");

  fs.writeFile(`${dirPath}/${key}.txt`, output, (error) => {
    if (error) throw error;
    //console.log(`${key}.txt written successfully!`);
  });
}

async function main() {
  const files = await fs.promises.readdir(dirPath);
  for (let i = 0; i < files.length; i++) {
    if (!files[i].endsWith(fileExt)) {
      continue;
    }

    const parts = files[i].split(/[\._]/);
    const key = [parts[0], parts[1]].join('_');
    const type = parts[2];
    if (!data[key]) {
      data[key] = {};
    }

    switch(type) {
      case 'original':
        data[key][type] = await uploadFileToOSS(files[i]);
        break;
      case 'output':
        data[key][type] = await readITXtChunk(files[i]);
        break;
      case 'controlnet':
        if (!data[key][type]) {
          data[key][type] = {};
        }
        data[key][type][parts[3]] = await uploadFileToOSS(files[i]);
        break;
      default:
        delete data[key];
        console.log(`wrong filename: ${files[i]}`);
        continue;
    }

  }

  for (const key in data) {
    data[key]['json'] = paramsToJSON(key);
    data[key]['targetParams'] = jsonToTargetParams(key);
    data[key]['targetPrompts'] = jsonToTargetPrompts(key);

    data[key]['errors'] = validParameters(key);
    if (data[key]['errors'].length > 0) {
      console.log('error:', key, data[key]['errors']);
    }

    writeParameters(key);
  }
}

main();
