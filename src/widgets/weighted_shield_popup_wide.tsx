import { renderWidget } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import { WeightedShieldPopup } from '../components/WeightedShieldPopupView';
import '../style.css';

renderWidget(withHoverTips(WeightedShieldPopup));
