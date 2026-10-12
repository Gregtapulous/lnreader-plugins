import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import dayjs from 'dayjs';

/**
 * Candidate diagnostic update for Scribble Hub after the 2026 redesign.
 * Not yet tested against a live Scribble Hub page, which returns HTTP 403
 * to automated inspection. Install only after backing up LNReader.
 *
 * Source: https://github.com/LNReader/lnreader-plugins/tree/master/plugins/english
 */
class ScribbleHubPlugin implements Plugin.PluginBase {
  id = 'scribblehub';
  name = 'Scribble Hub';
  icon = 'src/en/scribblehub/icon.png';
  site = 'https://www.scribblehub.com/';
  version = '1.0.4';

  private normalizePath(href: string | undefined): string | undefined {
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    try {
      const parsed = new URL(href, this.site);
      if (parsed.hostname !== 'www.scribblehub.com' && parsed.hostname !== 'scribblehub.com') return;
      return `${parsed.pathname.replace(/^\//, '')}${parsed.search}`;
    } catch {
      return;
    }
  }

  /**
   * Keep network responses and parser/layout failures distinct. In v1.0.3,
   * the word "cloudflare" anywhere in an otherwise valid page could trigger
   * a misleading "complete verification" error.
   *
   * A successful WebView login does not guarantee that fetch() uses the same
   * cookies/session or passes the site's anti-bot checks.
   */
  private async readPage(url: string, context: string, init?: Parameters<typeof fetchApi>[1]): Promise<{
    html: string; status: number; title: string;
  }> {
    const response = await fetchApi(url, init);
    const html = await response.text();
    const $ = parseHTML(html);
    const title = $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 100);
    const titleDisplay = title || '(no HTML title)';
    // Only treat recognizable challenge pages as challenges, rather than
    // finding the word "Cloudflare" somewhere in a normal website script.
    const challenge = /^(just a moment|attention required|checking your browser|verify you are human)/i.test(title) ||
      /<form[^>]*id=["']challenge-form["']/i.test(html) ||
      /<script[^>]+\/cdn-cgi\/challenge-platform\//i.test(html) ||
      /window\._cf_chl_opt\s*=/i.test(html);
    if (!response.ok) {
      throw new Error(`Scribble Hub ${context}: HTTP ${response.status}; page title: "${titleDisplay}". ` +
        'The website refused the plugin request; WebView authentication may not carry over.');
    }
    if (challenge) {
      throw new Error(`Scribble Hub ${context}: challenge page returned (HTTP ${response.status}; ` +
        `title: "${titleDisplay}"). LNReader's background request is not passing site verification.`);
    }
    return { html, status: response.status, title: titleDisplay };
  }

  parseNovels($: CheerioAPI): Plugin.NovelItem[] {
    const found = new Map<string, Plugin.NovelItem>();
    // Prefer the original card-based parser when its elements still exist.
    $('.search_main_box').each((_i, el) => {
      const root = $(el);
      const link = root.find('.search_title > a, .search_title a').first();
      const path = this.normalizePath(link.attr('href'));
      if (!path || !/^series\/\d+\//.test(path)) return;
      const name = link.text().trim();
      if (!name) return;
      const cover = root.find('.search_img img, img').first().attr('data-src') ||
        root.find('.search_img img, img').first().attr('src');
      found.set(path, { name, path, cover });
    });

    // 2026-compatible fallback: identify actual series links instead of
    // relying exclusively on a particular CSS class/card markup.
    $('a[href*="/series/"], a[href^="series/"]').each((_i, el) => {
      const link = $(el);
      const path = this.normalizePath(link.attr('href'));
      if (!path || !/^series\/\d+\//.test(path)) return;
      const name = (link.text() || link.attr('title') || '').replace(/\s+/g, ' ').trim();
      if (!name || /^(read|more|details|view|continue|next|previous)$/i.test(name)) return;

      // Use the nearest result card or an item-like ancestor for cover image.
      const container = link.closest('.search_main_box, .search_main, article, li, .series-card, .series-item, .search-result, .novel-item');
      const coverLink = container.length ? container : link.parent();
      const img = coverLink.find('img').first();
      const cover = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src');
      const previous = found.get(path);
      if (!previous || (name.length > previous.name.length && previous.name.length < 12)) {
        found.set(path, { name, path, cover: cover || previous?.cover });
      }
    });
    return Array.from(found.values());
  }

  async popularNovels(page: number, {
    showLatestNovels, filters,
  }: Plugin.PopularNovelsOptions<typeof this.filters>): Promise<Plugin.NovelItem[]> {
    let url = this.site;
    if (showLatestNovels) {
      url += `latest-series/?pg=${page}`;
    } else if (filters) {
      const params = new URLSearchParams();
      if (filters.genres.value.include?.length) params.append('gi', filters.genres.value.include.join(','));
      if (filters.genres.value.exclude?.length) params.append('ge', filters.genres.value.exclude.join(','));
      if (filters.genres.value.include?.length || filters.genres.value.exclude?.length) {
        params.append('mgi', filters.genre_operator.value);
      }
      if (filters.content_warning.value.include?.length) params.append('cti', filters.content_warning.value.include.join(','));
      if (filters.content_warning.value.exclude?.length) params.append('cte', filters.content_warning.value.exclude.join(','));
      if (filters.content_warning.value.include?.length || filters.content_warning.value.exclude?.length) {
        params.append('mct', filters.content_warning_operator.value);
      }
      params.append('cp', filters.storyStatus.value);
      params.append('sort', filters.sort.value);
      params.append('order', filters.order.value);
      params.append('pg', String(page));
      url += `series-finder/?sf=1&${params.toString()}`;
    } else {
      url += `series-finder/?sf=1&sort=ratings&order=desc&pg=${page}`;
    }
    const result = await this.readPage(url, 'browse');
    const novels = this.parseNovels(parseHTML(result.html));
    if (!novels.length && page === 1) throw new Error(`Scribble Hub browse: HTTP ${result.status}, title: "${result.title}", but no series links matched. Site layout or endpoint likely changed.`);
    return novels;
  }

  private parseChapterLinks($: CheerioAPI): Plugin.ChapterItem[] {
    const found = new Map<string, Plugin.ChapterItem>();
    const parseDate = (value: string): string | null => {
      const amount = Number(value.match(/\d+/)?.[0]);
      if (!Number.isFinite(amount)) return null;
      const unit = value.match(/(hour|day|month|year)/i)?.[1]?.toLowerCase() as 'hour' | 'day' | 'month' | 'year' | undefined;
      return unit ? dayjs().subtract(amount, unit).toISOString() : null;
    };

    // Legacy release list returned by wp-admin/admin-ajax.php.
    $('.toc_w').each((_i, el) => {
      const root = $(el);
      const anchor = root.find('a.toc_a, a[href*="/read/"]').first();
      const path = this.normalizePath(anchor.attr('href'));
      if (!path || !/^read\//.test(path)) return;
      found.set(path, {
        name: anchor.text().replace(/\s+/g, ' ').trim() || `Chapter ${found.size + 1}`,
        path,
        releaseTime: parseDate(root.find('.fic_date_pub').text()),
      });
    });

    // Fallback for revised chapter-list elements. Avoid unrelated links
    // by requiring Scribble Hub's /read/ chapter URL structure.
    $('a[href*="/read/"], a[href^="read/"]').each((_i, el) => {
      const anchor = $(el);
      const path = this.normalizePath(anchor.attr('href'));
      if (!path || !/^read\//.test(path) || found.has(path)) return;
      const name = (anchor.text() || anchor.attr('title') || '').replace(/\s+/g, ' ').trim();
      if (!name) return;
      found.set(path, { name, path });
    });
    return Array.from(found.values());
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const path = this.normalizePath(novelPath) || novelPath;
    const page = await this.readPage(this.site + path, 'series details');
    const $ = parseHTML(page.html);
    const novel: Plugin.SourceNovel = {
      path,
      name: $('.fic_title, .series-title, h1.entry-title, h1').first().text().trim() || 'Untitled',
      cover: $('.fic_image img, img.fic_image, .series-cover img').first().attr('data-src') ||
        $('.fic_image img, img.fic_image, .series-cover img').first().attr('src'),
      summary: $('.wi_fic_desc, .series-description, #description').first().text().trim(),
      author: $('.auth_name_fic, .series-author a').first().text().trim(),
      chapters: [],
    };
    novel.genres = $('.fic_genre, .series-genre').map((_i, el) => $(el).text().trim()).toArray().join(',');
    const statusText = $('.rnd_stats, .series-status').parent().text().toLowerCase();
    if (statusText.includes('ongoing')) novel.status = 'Ongoing';
    else if (statusText.includes('completed')) novel.status = 'Completed';

    // Keep the established Scribble Hub chapter endpoint; fall back to the
    // HTML links when AJAX is unavailable or its response structure changes.
    let chapters: Plugin.ChapterItem[] = [];
    const seriesId = path.match(/^series\/(\d+)/)?.[1];
    if (seriesId) {
      try {
        const formData = new FormData();
        formData.append('action', 'wi_getreleases_pagination');
        formData.append('pagenum', '-1');
        formData.append('mypostid', seriesId);
        const ajax = await this.readPage(`${this.site}wp-admin/admin-ajax.php`, 'chapter list', {
          method: 'POST', body: formData,
        });
        chapters = this.parseChapterLinks(parseHTML(ajax.html));
      } catch (_error) {
        // Fall back to reading the on-page chapter links.
      }
    }
    if (!chapters.length) chapters = this.parseChapterLinks($);
    if (!chapters.length) throw new Error('No chapter links found on Scribble Hub. Its AJAX endpoint or chapter-list markup may have changed.');
    novel.chapters = chapters.reverse();
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const path = this.normalizePath(chapterPath) || chapterPath;
    const page = await this.readPage(this.site + path, 'chapter content');
    const $ = parseHTML(page.html);
    const html = $('div.chp_raw, #chp_raw, .chapter-content, .reading-content, article.chapter').first().html() || '';
    if (!html.trim()) throw new Error('Chapter HTML was empty; Scribble Hub may have changed its reading-page markup.');
    return html;
  }

  async searchNovels(searchTerm: string): Promise<Plugin.NovelItem[]> {
    const url = `${this.site}?s=${encodeURIComponent(searchTerm)}&post_type=fictionposts`;
    const page = await this.readPage(url, 'search');
    const novels = this.parseNovels(parseHTML(page.html));
    if (!novels.length) console.log(`Scribble Hub search returned zero results (HTTP ${page.status}, title: ${page.title}).`);
    return novels;
  }

  // Retain original LNReader filters to preserve how the source is browsed.
  filters = {
    sort: { label: 'Sort Results By', value: 'ratings', options: [
      { label: 'Chapters', value: 'chapters' },
      { label: 'Chapters per Week', value: 'frequency' },
      { label: 'Date Added', value: 'dateadded' },
      { label: 'Favorites', value: 'favorites' },
      { label: 'Last Updated', value: 'lastchdate' },
      { label: 'Number of Ratings', value: 'numofrate' },
      { label: 'Pages', value: 'pages' },
      { label: 'Pageviews', value: 'pageviews' },
      { label: 'Ratings', value: 'ratings' },
      { label: 'Readers', value: 'readers' },
      { label: 'Reviews', value: 'reviews' },
      { label: 'Total Words', value: 'totalwords' },
    ], type: FilterTypes.Picker },
    order: { label: 'Order By', value: 'desc', options: [
      { label: 'Descending', value: 'desc' }, { label: 'Ascending', value: 'asc' },
    ], type: FilterTypes.Picker },
    storyStatus: { label: 'Story Status', value: 'all', options: [
      { label: 'All', value: 'all' }, { label: 'Completed', value: 'completed' },
      { label: 'Ongoing', value: 'ongoing' }, { label: 'Hiatus', value: 'hiatus' },
    ], type: FilterTypes.Picker },
    genre_operator: { value: 'and', label: 'Genres (And/Or)', options: [
      { label: 'And', value: 'and' }, { label: 'Or', value: 'or' },
    ], type: FilterTypes.Picker },
    genres: { label: 'Genres', value: { include: [], exclude: [] }, options: [
      { label: 'Action', value: '9' }, { label: 'Adult', value: '902' },
      { label: 'Adventure', value: '8' }, { label: 'Boys Love', value: '891' },
      { label: 'Comedy', value: '7' }, { label: 'Drama', value: '903' },
      { label: 'Ecchi', value: '904' }, { label: 'Fanfiction', value: '38' },
      { label: 'Fantasy', value: '19' }, { label: 'Gender Bender', value: '905' },
      { label: 'Girls Love', value: '892' }, { label: 'Harem', value: '1015' },
      { label: 'Historical', value: '21' }, { label: 'Horror', value: '22' },
      { label: 'Isekai', value: '37' }, { label: 'Josei', value: '906' },
      { label: 'LitRPG', value: '1180' }, { label: 'Martial Arts', value: '907' },
      { label: 'Mature', value: '20' }, { label: 'Mecha', value: '908' },
      { label: 'Mystery', value: '909' }, { label: 'Psychological', value: '910' },
      { label: 'Romance', value: '6' }, { label: 'School Life', value: '911' },
      { label: 'Sci-fi', value: '912' }, { label: 'Seinen', value: '913' },
      { label: 'Slice of Life', value: '914' }, { label: 'Smut', value: '915' },
      { label: 'Sports', value: '916' }, { label: 'Supernatural', value: '5' },
      { label: 'Tragedy', value: '901' },
    ], type: FilterTypes.ExcludableCheckboxGroup },
    content_warning_operator: { value: 'and', label: 'Mature Content (And/Or)', options: [
      { label: 'And', value: 'and' }, { label: 'Or', value: 'or' },
    ], type: FilterTypes.Picker },
    content_warning: { value: { include: [], exclude: [] }, label: 'Mature Content', options: [
      { label: 'Gore', value: '48' }, { label: 'Sexual Content', value: '50' },
      { label: 'Strong Language', value: '49' },
    ], type: FilterTypes.ExcludableCheckboxGroup },
  } satisfies Filters;
}

export default new ScribbleHubPlugin();
