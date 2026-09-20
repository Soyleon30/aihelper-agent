const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出本地目录内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录绝对路径或相对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取本地文本文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          encoding: { type: 'string', description: '编码，默认 utf8' },
          maxBytes: { type: 'number', description: '最大读取字节数' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入本地文件（覆盖或创建）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
          encoding: { type: 'string', description: '编码，默认 utf8' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: '追加内容到本地文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: '删除文件或空目录',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: '发送 HTTP 请求（GET/POST/PUT/DELETE/PATCH），可用于 API 或网页表单 POST。下载大文件请用 download_file。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', description: 'GET/POST/PUT/DELETE/PATCH' },
          headers: { type: 'object', description: '请求头键值对' },
          body: { type: 'string', description: '请求体字符串' },
          json: { type: 'object', description: '若提供则作为 JSON body' },
          form: { type: 'object', description: 'application/x-www-form-urlencoded 表单' },
          timeoutMs: { type: 'number' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description:
        '下载文件到配置的下载目录。同一 URL 默认只下一次（skipIfExists），避免按文档重复下载。返回本地绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文件 URL' },
          filename: { type: 'string', description: '可选保存文件名' },
          path: { type: 'string', description: '可选完整保存路径' },
          skipIfExists: {
            type: 'boolean',
            description: '默认 true：URL 或文件已存在则跳过'
          },
          force: { type: 'boolean', description: 'true 则强制重新下载' },
          timeoutMs: { type: 'number' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_from_markdown',
      description:
        '从 Markdown 文本或 md 文件中提取链接并批量下载。自动去重，已下载的 URL 会跳过。',
      parameters: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'md 正文' },
          path: { type: 'string', description: '本地 md 文件路径' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: '只下这些后缀，如 [\"pdf\",\"zip\",\"docx\"]'
          },
          filter: { type: 'string', description: 'URL 正则过滤' },
          skipIfExists: { type: 'boolean' },
          force: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_downloads',
      description: '列出下载目录中的文件',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_download_dir',
      description: '返回当前配置的下载目录绝对路径',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_test',
      description: '测试 Coremail/企业邮箱 IMAP 连接（只读，不发送）',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_list_folders',
      description: '列出邮箱文件夹（收件箱/已发送等）',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_list',
      description: '列出邮件（默认收件箱，新→旧）。只查看，不发送。',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '文件夹，默认 INBOX' },
          limit: { type: 'number', description: '条数，默认 20，最大 100' },
          unseenOnly: { type: 'boolean', description: '仅未读' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_search',
      description: '按发件人/主题/关键字等搜索邮件（只读）',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          query: { type: 'string', description: '正文关键字' },
          since: { type: 'string', description: '起始日期 ISO' },
          before: { type: 'string' },
          unseenOnly: { type: 'boolean' },
          limit: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_read',
      description: '读取一封邮件正文（需 uid）。只读查看，不发送、不删信。',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'number', description: 'mail_list 返回的 uid' },
          folder: { type: 'string' },
          maxChars: { type: 'number', description: '正文最大字符，默认 15000' }
        },
        required: ['uid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_state',
      description:
        '查看当前浏览器会话状态（是否已打开、当前 URL/标题/正文预览）。用户手动操作后继续任务时，应先调用本工具，再在当前页面上 click/type，不要轻易重新 navigate。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        '打开或跳转浏览器页面。若 browser_state 显示已在目标站，优先在当前页继续操作，勿重复打开。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          waitUntil: { type: 'string', description: 'load|domcontentloaded|networkidle' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击页面元素（CSS 选择器或文本）',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: '可见文本（与 selector 二选一）' },
          timeoutMs: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '在输入框中输入文字',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          clear: { type: 'boolean', description: '输入前是否清空' },
          pressEnter: { type: 'boolean', description: '输入后是否回车' }
        },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill_form',
      description: '批量填写表单字段',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                selector: { type: 'string' },
                value: { type: 'string' }
              },
              required: ['selector', 'value']
            }
          }
        },
        required: ['fields']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: '获取页面或元素文本',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '可选，默认整页 body' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_html',
      description: '获取页面或元素 HTML',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '截图并保存到本地',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '保存路径，可选' },
          fullPage: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: '等待选择器出现或固定毫秒',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          ms: { type: 'number' },
          timeoutMs: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: '在页面执行简单 JS 表达式并返回结果（只读查询优先）',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string' }
        },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: '关闭当前浏览器会话',
      parameters: { type: 'object', properties: {} }
    }
  }
];

module.exports = { TOOL_DEFINITIONS };
