/**
 * 拖拽上传与文件选择处理模块
 */

import { detectFromReader } from '../core/detect.js';
import { zipIo } from '../core/zip-io.js';

export function setupFileDrop({
  dropzoneEl,
  fileInputEl,
  mainTextEl,
  subTextEl,
  onFileReady,
  onError,
}) {
  let selectedFile = null;

  function setDragOver(isOver) {
    if (isOver) dropzoneEl.classList.add('dragover');
    else dropzoneEl.classList.remove('dragover');
  }

  dropzoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  });

  dropzoneEl.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  });

  dropzoneEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await handleFile(files[0]);
    }
  });

  dropzoneEl.addEventListener('click', () => {
    fileInputEl.click();
  });

  fileInputEl.addEventListener('change', async () => {
    if (fileInputEl.files && fileInputEl.files.length > 0) {
      await handleFile(fileInputEl.files[0]);
    }
  });

  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      if (onError) onError(new Error('请选择 .zip 格式的酒馆备份压缩包'));
      return;
    }

    selectedFile = file;
    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    mainTextEl.textContent = `📁 ${file.name} (${sizeMb} MB)`;
    subTextEl.textContent = '正在分析包结构并自动嗅探源平台...';

    try {
      const reader = await zipIo.openReader(file);
      let detection;
      try {
        detection = await detectFromReader(reader);
      } finally {
        await reader.close();
      }

      const layoutNames = {
        st: 'SillyTavern (摊平布局)',
        l: 'Luker (带清单布局)',
        tt: 'TauriTavern (data/ 根布局)',
        'pt-native': 'PureTavern (原生 sha256 归档)',
        unknown: '未知格式',
      };

      const detectedName = layoutNames[detection.layout] ?? detection.layout;
      subTextEl.textContent = `已识别源平台: ${detectedName} (${detection.evidence})`;

      if (onFileReady) {
        onFileReady(file, detection);
      }
    } catch (err) {
      subTextEl.textContent = `分析失败: ${err.message}`;
      if (onError) onError(err);
    }
  }

  return {
    getSelectedFile: () => selectedFile,
    clear: () => {
      selectedFile = null;
      fileInputEl.value = '';
      mainTextEl.textContent = '将酒馆 Zip 数据包拖放到此处，或点击浏览选择';
      subTextEl.textContent = '支持任意四平台（ST / Luker / TT / PT）导出的备份压缩包';
    },
  };
}
