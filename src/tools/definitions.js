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
      description:
        '检测本机 Coremail 客户端/网页会话是否可用（不使用 IMAP/POP3，只读）',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_launch_client',
      description: '启动本机已安装的 Coremail 客户端程序（需配置 exePath）',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_list_folders',
      description: '从 Coremail 界面侧栏尝试列出文件夹名称',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_list',
      description:
        '通过本机 Coremail 客户端/已登录网页列出邮件（非 IMAP）。返回 id/index/subject/from。',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '文件夹名，如 收件箱' },
          limit: { type: 'number', description: '条数，默认 20，最大 50' },
          unseenOnly: { type: 'boolean', description: '仅未读（尽力）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_search',
      description: '在 Coremail 界面搜索框搜索邮件（非 IMAP）',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          from: { type: 'string' },
          subject: { type: 'string' },
          limit: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mail_read',
      description:
        '在 Coremail 界面打开并读取一封邮件正文。用 mail_list 的 index 或 id。只读不发送。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '列表序号，从 1 起' },
          id: { type: 'string', description: '列表返回的 id' },
          uid: { type: 'number', description: '兼容旧参数，等同 index' },
          maxChars: { type: 'number', description: '正文最大字符，默认 15000' }
        }
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
      description:
        '点击页面元素（CSS 选择器或文本）。自动优先可见节点，失败时 force/JS 回退，适合 Element 表格「详情」等易点到隐藏列的场景。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: '可见文本（与 selector 二选一）' },
          timeoutMs: { type: 'number' },
          force: { type: 'boolean', description: 'true=强制点击；false=禁用 force 回退' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_record_start',
      description:
        '开始录制用户在浏览器中的点击/输入。请先打开目标页，再调用本工具，然后人工操作；结束后 browser_record_stop。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '流程名，默认 flow-时间戳' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_record_stop',
      description:
        '结束录制并保存为流程 JSON（userData/flows）。输入内容默认变量化成 {{变量}}，回放时用 vars 覆盖。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选保存路径' },
          detectVariables: { type: 'boolean', description: '是否自动把输入标成变量，默认 true' },
          variables: { type: 'object', description: '可选：预设/覆盖变量示例值' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_record_status',
      description: '查看当前是否在录制及已录步骤数',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_flow_list',
      description: '列出已保存的操作流程（录制产物）',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_flow_run',
      description:
        '按录制流程回放。vars 覆盖变量，例如 {"应用名":"bsdmp","日志路径":"/app/log"}。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '流程名（flows 目录下）' },
          path: { type: 'string', description: '流程 JSON 路径' },
          vars: {
            type: 'object',
            description: '变量键值，替换步骤中的 {{key}}'
          }
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
      description:
        '截图并保存到配置的截图目录（默认 图片/AIHelper-Screenshots）。返回 path 绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选：绝对路径或相对截图目录的文件名' },
          fullPage: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_screenshot_dir',
      description: '返回当前截图保存目录的绝对路径',
      parameters: { type: 'object', properties: {} }
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
