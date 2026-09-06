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
  onFilesReady,
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
      await handleFiles(files);
    }
  });

  dropzoneEl.addEventListener('click', () => {
    fileInputEl.click();
  });

  fileInputEl.addEventListener('change', async () => {
    if (fileInputEl.files && fileInputEl.files.length > 0) {
      await handleFiles(fileInputEl.files);
    }
  });

  async function handleFiles(fileList) {
    const rawFiles = Array.from(fileList);
    const zipFiles = rawFiles.filter((f) => f.name.toLowerCase().endsWith('.zip'));

    if (zipFiles.length === 0) {
      if (onError) onError(new Error('请选择 .zip 格式的酒馆备份压缩包'));
      return;
    }

    const layoutNames = {
      st: 'SillyTavern',
      l: 'Luker',
      tt: 'TauriTavern',
      'pt-native': 'PureTavern',
      unknown: '未知格式',
    };

    if (zipFiles.length === 1) {
      const file = zipFiles[0];
      selectedFile = file;
      const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
      mainTextEl.innerHTML = `<i class="fa-solid fa-file-zipper"></i> ${file.name} (${sizeMb} MB)`;
      subTextEl.textContent = '正在分析包结构并自动嗅探源平台...';

      try {
        const reader = await zipIo.openReader(file);
        let detection;
        try {
          detection = await detectFromReader(reader);
        } finally {
          await reader.close();
        }

        const detectedName = layoutNames[detection.layout] ?? detection.layout;
        subTextEl.textContent = `已识别源平台: ${detectedName} (${detection.evidence})`;

        if (onFilesReady) {
          onFilesReady([{ file, detection }]);
        } else if (onFileReady) {
          onFileReady(file, detection);
        }
      } catch (err) {
        subTextEl.textContent = `分析失败: ${err.message}`;
        if (onError) onError(err);
      }
    } else {
      mainTextEl.innerHTML = `<i class="fa-solid fa-boxes-stacked"></i> 已选择 ${zipFiles.length} 个数据包`;
      subTextEl.textContent = '正在批量分析并存入工作区...';

      const results = [];
      for (const file of zipFiles) {
        try {
          const reader = await zipIo.openReader(file);
          let detection;
          try {
            detection = await detectFromReader(reader);
          } finally {
            await reader.close();
          }
          results.push({ file, detection });
        } catch (err) {
          console.warn(`分析 ${file.name} 失败:`, err);
        }
      }

      selectedFile = results[0]?.file || null;
      subTextEl.textContent = `已识别并存入 ${results.length} 个数据包到工作区`;

      if (onFilesReady) {
        onFilesReady(results);
      } else if (results.length > 0 && onFileReady) {
        onFileReady(results[0].file, results[0].detection);
      }
    }
  }

  return {
    getSelectedFile: () => selectedFile,
    setFilename: (name) => {
      if (mainTextEl) mainTextEl.innerHTML = `<i class="fa-solid fa-file-zipper"></i> ${name}`;
    },
    clear: () => {
      selectedFile = null;
      fileInputEl.value = '';
      mainTextEl.textContent = '将酒馆 Zip 数据包拖放到此处，或点击浏览选择';
      subTextEl.textContent = '支持多选或同时拖入多个 Zip 备份包批量入库';
    },
  };
}
