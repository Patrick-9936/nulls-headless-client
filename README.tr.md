# nulls headless client

[RU](README.md) · [EN](README.en.md) · **TR** · [ZH](README.zh.md)

[![ci](https://github.com/Patrick-9936/nulls-headless-client/actions/workflows/ci.yml/badge.svg)](https://github.com/Patrick-9936/nulls-headless-client/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Patrick-9936/nulls-headless-client)](https://github.com/Patrick-9936/nulls-headless-client/releases)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Nulls Brawl 69.252** protokolü için headless Node.js istemcisi: hesaplar, kulüpler, lobi,
arkadaşlar, maç izleme ve aynı anda birden fazla oturum. Oyun kurulumu yok, root yok, APK
yamalama yok — sadece ağ ve protokol.

Resmî olmayan proje; Supercell veya Nulls ile bağlantılı değildir. Kod MIT lisanslıdır
([`LICENSE`](LICENSE)), oyun ve varlıklarıyla ilgili notlar [`NOTICE.md`](NOTICE.md) içinde.
Node.js 20+ gerekir; Windows, Linux, macOS ve Android (Termux) üzerinde çalışır.

## Neler yapar

| Alan | Yetenekler |
|---|---|
| Hesaplar | misafir oluşturma, token ile giriş, bölge, cihaz değiştirme, iki oturuma karşı dosya kilidi |
| Kulüpler | kurma, katılma, sohbet, akış, başvurular, roller, atma, davetler, ayarlar, sıralama |
| Lobi | oda kurma veya kodla katılma, arkadaş/kulüp davetleri, yanıtlar, mod ve harita, hazır durumu |
| Arkadaşlar | etiketle ekleme, kabul, red, silme, liste ve çevrimiçi durum |
| Maç | eşleşme, iptal, maç yükleme, UDP çerçeveleri, Brawl TV ve oyuncu izleme |
| Filo | onlarca bot çalıştırma, canlı komutlar, duraklat/devam, bot başına durum |
| Arayüz | etkileşimli menü, CLI, dört dil (ru / en / tr / zh), betikler için JSON çıktısı |
| Bağlantı | Nulls Connect: e-posta ile PIN, bearer token, oyun hesabı bağlama |

Canlı sunucuda neyin doğrulandığı: [`docs/VERIFICATION.md`](docs/VERIFICATION.md) ve
`node Program.js features`.

## Hızlı başlangıç

### Tek dosya

[Son sürümden](https://github.com/Patrick-9936/nulls-headless-client/releases/latest)
`Nulls.js` dosyasını indir:

```sh
node Nulls.js
```

Ok tuşları, enter, esc, ctrl+c. İlk çalıştırmada betiğin yanında `.nulls-single-<sürüm>`
klasörü oluşur — silme, kayıtlı girişler orada. Ayrıntılar: [`docs/TUI.md`](docs/TUI.md).

### git ile

```sh
git clone https://github.com/Patrick-9936/nulls-headless-client.git
cd nulls-headless-client
npm ci --ignore-scripts
node TUI.js
```

### Termux

**Ev dizinine** aç, Android'in paylaşılan depolamasına değil — orada durum dosyaları için
yazma izni yok:

```sh
cd ~ && unzip nulls-headless-client.zip && cd nulls-headless-client
node TUI.js
```

## Belgeler

| Belge | İçerik |
|---|---|
| [`docs/PLATFORMS.md`](docs/PLATFORMS.md) | nerede ne çalışır, Termux sınırları |
| [`docs/COMMANDS.md`](docs/COMMANDS.md) | tam CLI referansı |
| [`docs/FLEET.md`](docs/FLEET.md) | bot filoları |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | istemcinin yapısı |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | canlı sunucuda doğrulananlar |

Tam ayrıntı Rusça README'de: [`README.md`](README.md).

## Lisans

Kaynak kodu MIT. Oyun varlıkları, APK içeriği ve paket dökümleri kapsam dışıdır —
bkz. [`NOTICE.md`](NOTICE.md).