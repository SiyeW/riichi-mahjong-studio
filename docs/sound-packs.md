### [中文](#%E4%B8%AD%E6%96%87) | [日本語](#%E6%97%A5%E6%9C%AC%E8%AA%9E) | [English](#english)

## 中文

### 自定义音效包

音效包由一个清单文件和清单引用的音频文件组成。主程序在启动时读取音效包，并在“设置 → 音效 → 音效包”中显示识别到的选项。

音效包可以只提供部分声音事件。没有提供的事件不会播放声音。

#### 目录结构

推荐将每套音效包放在单独的目录中：

```text
sound-packs/
  example/
    example.soundpack.json
    sounds/
      discard.ogg
      pon.ogg
      ron.ogg
```

清单文件名必须以 `.soundpack.json` 结尾。音频文件可以放在清单旁边，也可以放在其子目录中。

同一目录可以放置多份清单。多份清单可以引用相同的音频文件，因此不同音效包不必复制共用声音。

#### 清单格式

```json
{
  "schemaVersion": 1,
  "id": "example.author.voice",
  "name": "Example Voice",
  "version": "1.0.0",
  "sounds": {
    "tile.discard": "sounds/discard.ogg",
    "call.pon": "sounds/pon.ogg",
    "win.ron": "sounds/ron.ogg"
  }
}
```

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 是 | 当前固定为 `1` |
| `id` | 是 | 音效包的稳定标识，必须在所有已安装音效包中保持唯一 |
| `name` | 是 | 在程序设置中显示的名称 |
| `version` | 是 | 采用语义化版本格式，例如 `1.0.0` |
| `sounds` | 是 | 声音事件与音频文件相对路径的对应关系，至少包含一个事件 |

`id` 长度为 3 至 128 个字符，只能使用小写英文字母、数字、点、下划线和连字符，并且必须以字母或数字开头。音效包发布后应尽量保持 `id` 不变。

音频路径必须：

- 相对于清单文件所在目录
- 使用正斜杠 `/`
- 不包含 `..`
- 不是绝对路径
- 指向 `.flac`、`.mp3`、`.ogg` 或 `.wav` 文件

#### 声音事件

| 事件 | 播放时机 |
| --- | --- |
| `action.confirmed` | 待确认的操作得到确认 |
| `action.required` | 对局模式中出现需要用户选择的特殊操作 |
| `call.chi` | 吃 |
| `call.kan` | 大明杠、暗杠或加杠 |
| `call.pon` | 碰 |
| `call.riichi` | 立直 |
| `review.required` | 进入操作复核 |
| `round.result` | 显示本局结果 |
| `tile.discard` | 打牌 |
| `win.ron` | 荣和 |
| `win.tsumo` | 自摸和 |

清单中的 `sounds` 只能使用以上事件名称。每个事件只能对应一个音频文件。

#### 安装与调试

发布版会读取主程序旁的 `sound-packs` 目录。开发环境默认读取仓库中的 `.mjai-runtime/sound-packs` 目录。

调试其他位置的音效包时，可以在 `.vscode/launch.local.env` 中设置 `RMS_SOUND_PACK_ROOTS`：

```text
RMS_SOUND_PACK_ROOTS=C:\path\to\first-pack-root;C:\path\to\second-pack-root
```

Windows 下使用分号分隔多个目录。添加或修改音效包后需要重新启动程序。识别成功的音效包会出现在“设置 → 音效 → 音效包”中；清单格式错误、标识重复或音频文件缺失的音效包不会出现。

#### 发布与许可

只能发布自己拥有相应权利，或许可证明确允许再分发的音频文件。使用第三方音频时，应遵守其署名、修改说明、相同方式共享或其他许可条件。

建议在音效包中附带 `LICENSE` 或相应的第三方声明，并写明音频来源、作者和许可证。清单本身不会代替这些文件。

---

## 日本語

### カスタム効果音パック

効果音パックは、1 つのマニフェストと、そこから参照される音声ファイルで構成されます。アプリケーションは起動時に効果音パックを読み込み、認識したパックを「设置 → 音效 → 音效包」に表示します。

一部のイベントだけを含む効果音パックも作成できます。音声が指定されていないイベントでは何も再生されません。

#### ディレクトリ構成

効果音パックごとに個別のディレクトリを用意することを推奨します。

```text
sound-packs/
  example/
    example.soundpack.json
    sounds/
      discard.ogg
      pon.ogg
      ron.ogg
```

マニフェストのファイル名は `.soundpack.json` で終わる必要があります。音声ファイルはマニフェストと同じ場所、またはその下のディレクトリに配置できます。

同じディレクトリに複数のマニフェストを置くこともできます。複数のマニフェストから同じ音声ファイルを参照できるため、共通の音声をパックごとに複製する必要はありません。

#### マニフェスト形式

```json
{
  "schemaVersion": 1,
  "id": "example.author.voice",
  "name": "Example Voice",
  "version": "1.0.0",
  "sounds": {
    "tile.discard": "sounds/discard.ogg",
    "call.pon": "sounds/pon.ogg",
    "win.ron": "sounds/ron.ogg"
  }
}
```

| フィールド | 必須 | 内容 |
| --- | --- | --- |
| `schemaVersion` | はい | 現在は `1` 固定 |
| `id` | はい | インストール済みの全パックで一意となる、安定した識別子 |
| `name` | はい | アプリケーションの設定に表示される名前 |
| `version` | はい | `1.0.0` などのセマンティックバージョン |
| `sounds` | はい | イベント名と音声ファイルの相対パスの対応。1 件以上必要 |

`id` は 3 文字以上 128 文字以下で、小文字の英字、数字、ピリオド、アンダースコア、ハイフンだけを使用し、先頭は英字または数字にします。公開後は同じ `id` を維持することを推奨します。

音声ファイルのパスには、次の条件があります。

- マニフェストのあるディレクトリからの相対パス
- 区切り文字にスラッシュ `/` を使用
- `..` を含めない
- 絶対パスにしない
- 拡張子が `.flac`、`.mp3`、`.ogg`、`.wav` のいずれか

#### 効果音イベント

| イベント | 再生される場面 |
| --- | --- |
| `action.confirmed` | 確認待ちの操作が確定したとき |
| `action.required` | 対局モードで特別な操作の選択が必要になったとき |
| `call.chi` | チー |
| `call.kan` | 大明槓、暗槓、加槓 |
| `call.pon` | ポン |
| `call.riichi` | リーチ |
| `review.required` | 操作の確認に入ったとき |
| `round.result` | 局の結果が表示されたとき |
| `tile.discard` | 打牌 |
| `win.ron` | ロン |
| `win.tsumo` | ツモ |

マニフェストの `sounds` には、上記のイベント名だけを使用できます。各イベントに指定できる音声ファイルは 1 つです。

#### 導入と確認

配布版は、アプリケーションと同じ場所にある `sound-packs` ディレクトリを読み込みます。開発環境では、リポジトリ内の `.mjai-runtime/sound-packs` が既定の読み込み先です。

別の場所にある効果音パックを試す場合は、`.vscode/launch.local.env` で `RMS_SOUND_PACK_ROOTS` を指定できます。

```text
RMS_SOUND_PACK_ROOTS=C:\path\to\first-pack-root;C:\path\to\second-pack-root
```

Windows では、複数のディレクトリをセミコロンで区切ります。効果音パックを追加または変更した後は、アプリケーションを再起動してください。認識されたパックは「设置 → 音效 → 音效包」に表示されます。マニフェストの形式が正しくない、`id` が重複している、音声ファイルが見つからない場合、そのパックは表示されません。

#### 公開とライセンス

自分が必要な権利を持つ音声、またはライセンスで再配布が明確に許可されている音声だけを公開してください。第三者の音声を使用する場合は、クレジット、変更の表示、継承条件など、そのライセンスの条件に従う必要があります。

効果音パックには `LICENSE` または第三者通知を添付し、音声の出典、作者、ライセンスを記載することを推奨します。マニフェストはこれらの文書の代わりにはなりません。

---

## English

### Custom sound packs

A sound pack consists of a manifest and the audio files referenced by that manifest. The application reads sound packs at startup and lists recognized packs under “设置 → 音效 → 音效包.”

A sound pack may provide only some events. Events without an assigned audio file remain silent.

#### Directory structure

Keeping each sound pack in its own directory is recommended:

```text
sound-packs/
  example/
    example.soundpack.json
    sounds/
      discard.ogg
      pon.ogg
      ron.ogg
```

The manifest file name must end in `.soundpack.json`. Audio files may be placed beside the manifest or in directories below it.

One directory may contain multiple manifests. Those manifests may reference the same audio files, so sounds shared by several packs do not need to be duplicated.

#### Manifest format

```json
{
  "schemaVersion": 1,
  "id": "example.author.voice",
  "name": "Example Voice",
  "version": "1.0.0",
  "sounds": {
    "tile.discard": "sounds/discard.ogg",
    "call.pon": "sounds/pon.ogg",
    "win.ron": "sounds/ron.ogg"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | Yes | Currently fixed at `1` |
| `id` | Yes | A stable identifier that must be unique among all installed sound packs |
| `name` | Yes | The name shown in the application settings |
| `version` | Yes | A semantic version such as `1.0.0` |
| `sounds` | Yes | A map from sound events to relative audio file paths, with at least one entry |

An `id` must be between 3 and 128 characters long. It may contain only lowercase English letters, digits, periods, underscores, and hyphens, and it must begin with a letter or digit. Keeping the same `id` after a pack is released is recommended.

Audio paths must:

- Be relative to the directory containing the manifest
- Use forward slashes `/`
- Not contain `..`
- Not be absolute
- Point to a `.flac`, `.mp3`, `.ogg`, or `.wav` file

#### Sound events

| Event | When it plays |
| --- | --- |
| `action.confirmed` | A pending action is confirmed |
| `action.required` | A special action choice becomes available in play mode |
| `call.chi` | Chi |
| `call.kan` | Daiminkan, ankan, or kakan |
| `call.pon` | Pon |
| `call.riichi` | Riichi |
| `review.required` | An action review begins |
| `round.result` | The round result appears |
| `tile.discard` | A tile is discarded |
| `win.ron` | Ron |
| `win.tsumo` | Tsumo |

Only the event names listed above may be used in `sounds`. Each event may reference one audio file.

#### Installation and testing

Release builds read the `sound-packs` directory beside the application. In the development environment, the default location is `.mjai-runtime/sound-packs` in the repository.

To test sound packs stored elsewhere, set `RMS_SOUND_PACK_ROOTS` in `.vscode/launch.local.env`:

```text
RMS_SOUND_PACK_ROOTS=C:\path\to\first-pack-root;C:\path\to\second-pack-root
```

On Windows, separate multiple directories with semicolons. Restart the application after adding or changing a sound pack. Recognized packs appear under “设置 → 音效 → 音效包.” A pack does not appear if its manifest is invalid, its `id` is already in use, or a referenced audio file is missing.

#### Distribution and licensing

Distribute only audio that you have the necessary rights to use or that is explicitly licensed for redistribution. When using third-party audio, follow all applicable requirements for attribution, modification notices, share-alike terms, or other conditions.

Including a `LICENSE` file or appropriate third-party notices with the sound pack is recommended. Identify the source, creator, and license of the audio. The manifest does not replace these documents.
