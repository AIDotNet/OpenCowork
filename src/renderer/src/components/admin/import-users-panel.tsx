import React, { useState } from 'react';

export const ImportUsersPanel: React.FC = () => {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    success: number;
    failed: number;
    errors: Array<{ row: number; error: string }>;
  } | null>(null);

  const handleDownloadTemplate = async () => {
    try {
      const res = await window.api.importDownloadTemplate();
      
      if (!res.success) {
        alert('下载模板失败: ' + res.error);
        return;
      }

      // Create download link
      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'user_import_template.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error: any) {
      alert('下载失败: ' + error.message);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setResult(null);

    try {
      const buffer = await file.arrayBuffer();
      const res = await window.api.importUsers(Buffer.from(buffer));

      if (!res.success) {
        alert('导入失败: ' + res.error);
        return;
      }

      setResult(res.data);
    } catch (error: any) {
      alert('导入失败: ' + error.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">批量导入用户</h1>

      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">使用说明</h3>
        <ol className="text-sm text-blue-700 dark:text-blue-300 space-y-1 list-decimal list-inside">
          <li>下载导入模板文件</li>
          <li>按照模板格式填写用户信息</li>
          <li>上传填写好的Excel文件</li>
          <li>查看导入结果</li>
        </ol>
      </div>

      <div className="flex gap-4">
        <button
          onClick={handleDownloadTemplate}
          className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
        >
          📥 下载导入模板
        </button>

        <label className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors cursor-pointer">
          📤 上传Excel文件
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileUpload}
            className="hidden"
            disabled={importing}
          />
        </label>
      </div>

      {importing && (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="mt-2 text-gray-600 dark:text-gray-400">正在导入...</p>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
              <p className="text-sm text-green-600 dark:text-green-400">成功导入</p>
              <p className="text-2xl font-bold text-green-700 dark:text-green-300">{result.success} 人</p>
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
              <p className="text-sm text-red-600 dark:text-red-400">导入失败</p>
              <p className="text-2xl font-bold text-red-700 dark:text-red-300">{result.failed} 人</p>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">错误详情</h3>
              </div>
              <div className="p-6">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead>
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">行号</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">错误信息</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {result.errors.map((err, idx) => (
                      <tr key={idx}>
                        <td className="px-4 py-2 text-sm text-gray-900 dark:text-white">第 {err.row} 行</td>
                        <td className="px-4 py-2 text-sm text-red-600 dark:text-red-400">{err.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
