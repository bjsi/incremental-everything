import { renderWidget } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import { SearchBrowse } from '../components/SearchBrowseView';
import '../style.css';

renderWidget(withHoverTips(SearchBrowse));
